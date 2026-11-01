#!/usr/bin/env node
/**
 * Integration test for the HTTP-first chat server.
 *
 * Usage:
 *   node tests/test-chat.mjs                    # test codex (default)
 *   node tests/test-chat.mjs claude             # test claude
 *   node tests/test-chat.mjs codex              # test codex
 *
 * Requires chat-server to be running on CHAT_PORT (default 7690).
 */
import http from 'http';
import WebSocket from 'ws';
import { CHAT_PORT, AUTH_FILE } from '../lib/config.mjs';
import { readFileSync } from 'fs';

const TOOL = process.argv[2] || 'codex';
const BASE = `http://127.0.0.1:${CHAT_PORT}`;
const FOLDER = process.cwd();

function log(tag, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}]`, ...args);
}

function fail(msg) {
  console.error(`\n❌ FAIL: ${msg}`);
  process.exit(1);
}

function pass(msg) {
  console.log(`\n✅ PASS: ${msg}`);
}

function request(method, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const reqOpts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { ...opts.headers },
    };
    if (opts.cookie) reqOpts.headers.Cookie = opts.cookie;

    const req = http.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function waitFor(predicate, description, timeout = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timeout (${timeout}ms) waiting for: ${description}`);
}

async function fetchJson(cookie, path) {
  const res = await request('GET', path, { cookie });
  if (res.status !== 200) {
    throw new Error(`GET ${path} failed: ${res.status} ${res.body.slice(0, 200)}`);
  }
  return res.json;
}

async function postJson(cookie, path, payload) {
  const res = await request('POST', path, {
    cookie,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`POST ${path} failed: ${res.status} ${res.body.slice(0, 200)}`);
  }
  return res.json;
}

async function patchJson(cookie, path, payload) {
  const res = await request('PATCH', path, {
    cookie,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`PATCH ${path} failed: ${res.status} ${res.body.slice(0, 200)}`);
  }
  return res.json;
}

async function waitForRun(cookie, runId) {
  return waitFor(async () => {
    const data = await fetchJson(cookie, `/api/runs/${runId}`);
    return ['completed', 'failed', 'cancelled'].includes(data.run?.state) ? data.run : null;
  }, `run ${runId} terminal`);
}

async function sendMessage(cookie, sessionId, text) {
  const requestId = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return postJson(cookie, `/api/sessions/${sessionId}/messages`, {
    requestId,
    text,
    tool: TOOL,
  });
}

async function fetchAllEvents(cookie, sessionId) {
  return fetchJson(cookie, `/api/sessions/${sessionId}/events`);
}

function getMaxEventSeq(events) {
  if (!Array.isArray(events) || events.length === 0) return 0;
  return events.reduce((maxSeq, event) => (
    Number.isInteger(event?.seq) && event.seq > maxSeq ? event.seq : maxSeq
  ), 0);
}

async function fetchEventBody(cookie, sessionId, seq) {
  const data = await fetchJson(cookie, `/api/sessions/${sessionId}/events/${seq}/body`);
  return data.body?.value || '';
}

async function resolveMessageContent(cookie, sessionId, event) {
  if (!event) return '';
  if (event.type !== 'message') return '';
  if (typeof event.content === 'string' && event.content) return event.content;
  if (!event.bodyAvailable || !Number.isInteger(event.seq)) return '';
  return fetchEventBody(cookie, sessionId, event.seq);
}

async function waitForAssistantReplyAfter(cookie, sessionId, afterSeq = 0) {
  return waitFor(async () => {
    const data = await fetchAllEvents(cookie, sessionId);
    const reply = [...(data.events || [])]
      .reverse()
      .find((event) => (
        event.type === 'message'
        && event.role === 'assistant'
        && Number.isInteger(event.seq)
        && event.seq > afterSeq
      ));
    if (!reply) return null;
    const content = await resolveMessageContent(cookie, sessionId, reply);
    if (!content) return null;
    return {
      content,
      events: data.events || [],
      reply,
    };
  }, `assistant reply after seq ${afterSeq}`);
}

async function main() {
  log('test', `Testing tool=${TOOL}, server=${BASE}, folder=${FOLDER}`);

  log('test', 'Step 1: Authenticating...');
  const auth = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
  const authRes = await request('GET', `/?token=${auth.token}`);
  if (authRes.status !== 302) fail(`Auth failed: status=${authRes.status}`);
  const setCookie = authRes.headers['set-cookie'];
  if (!setCookie) fail('No Set-Cookie header');
  const cookie = setCookie[0].split(';')[0];

  log('test', 'Step 2: Connecting WebSocket for invalidation hints...');
  const ws = new WebSocket(`ws://127.0.0.1:${CHAT_PORT}/ws`, {
    headers: { Cookie: cookie },
  });
  const wsMessages = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 5000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on('error', reject);
    ws.on('message', (raw) => wsMessages.push(JSON.parse(raw.toString())));
  });

  log('test', 'Step 3: Creating session via HTTP...');
  const created = await postJson(cookie, '/api/sessions', {
    folder: FOLDER,
    tool: TOOL,
    name: 'HTTP integration test',
    group: 'Tests',
    description: 'HTTP-first integration check',
  });
  const session = created.session;
  if (!session?.id) fail('No session created');

  log('test', 'Step 4: Sending first message via HTTP...');
  const eventsBeforeFirst = await fetchAllEvents(cookie, session.id);
  const firstBaselineSeq = getMaxEventSeq(eventsBeforeFirst.events);
  const first = await sendMessage(cookie, session.id, '记住这个数字：42。只回复“已记住”。');
  if (first.run?.id) {
    await waitForRun(cookie, first.run.id);
  }
  const firstTurn = await waitForAssistantReplyAfter(cookie, session.id, firstBaselineSeq);
  const firstEvents = { events: firstTurn.events };
  const firstReplyContent = firstTurn.content;
  if (!firstReplyContent) fail('No assistant reply found after first message');
  log('test', `First reply: ${firstReplyContent.slice(0, 120)}`);
  pass('First message got a response');

  log('test', 'Step 5: Sending follow-up context test via HTTP...');
  const secondBaselineSeq = getMaxEventSeq(firstEvents.events);
  const second = await sendMessage(cookie, session.id, '我让你记住的数字是什么？只回复那个数字本身。');
  if (second.run?.id) {
    await waitForRun(cookie, second.run.id);
  }
  const secondTurn = await waitForAssistantReplyAfter(cookie, session.id, secondBaselineSeq);
  const secondReplyContent = secondTurn.content;
  if (!secondReplyContent) fail('No assistant reply found after second message');
  log('test', `Second reply: ${secondReplyContent.slice(0, 120)}`);

  if (!secondReplyContent.includes('42')) {
    fail(`Context lost. Reply was: "${secondReplyContent.slice(0, 200)}"`);
  }
  pass('Context preserved through HTTP-first flow');

  if (wsMessages.some((msg) => ['session', 'sessions', 'history', 'event', 'sidebar_update'].includes(msg.type))) {
    fail(`WebSocket carried state-bearing payloads: ${wsMessages.map((msg) => msg.type).join(', ')}`);
  }
  pass('WebSocket stayed hint-only');

  log('test', 'Step 6: Renaming and archiving via HTTP...');
  await patchJson(cookie, `/api/sessions/${session.id}`, { name: 'HTTP integration renamed' });
  const archived = await patchJson(cookie, `/api/sessions/${session.id}`, { archived: true });
  if (!archived.session?.archived) fail('Archive flag was not applied');
  const listedArchived = await fetchJson(cookie, '/api/sessions/archived');
  const archivedEntry = (listedArchived.sessions || []).find((item) => item.id === session.id);
  if (!archivedEntry) fail('Archived session did not appear in archived session list');
  if (!archivedEntry.archived) fail('Archived session list did not expose archived flag');
  const restored = await patchJson(cookie, `/api/sessions/${session.id}`, { archived: false });
  if (restored.session?.archived) fail('Archive flag was not cleared');
  const listedRestored = await fetchJson(cookie, '/api/sessions');
  const restoredEntry = (listedRestored.sessions || []).find((item) => item.id === session.id);
  if (!restoredEntry) fail('Restored session did not return to active session list');
  if (restoredEntry.archived) fail('Session list did not clear archived flag after restore');

  ws.close();
  log('test', 'Done!');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
