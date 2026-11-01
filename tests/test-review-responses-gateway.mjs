import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createReviewResponsesGateway, REVIEW_MODEL } from '../lib/review-responses-gateway.mjs';

const key = 'scoped-fixture-key-not-an-openai-token-123456';
const body = { model: REVIEW_MODEL, input: [{ role: 'user', content: 'Synthetic sample' }], stream: true, store: false };
let calls = 0, credentials = 0, upstreamMode = 'ok', held;
const server = createReviewResponsesGateway({
  clientKey: key, upstreamUrl: 'https://api.openai.com/v1/responses', maxBodyBytes: 2048, maxConcurrent: 1,
  getAccessCredential: async () => { credentials++; return { accessToken: 'private-access-fixture', refreshToken: 'never-forward-refresh-fixture', accountId: 'private-account-fixture' }; },
  fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer private-access-fixture');
    assert.equal(options.headers['chatgpt-account-id'], 'private-account-fixture');
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.headers['x-forwarded-host'], undefined);
    assert.equal(JSON.stringify(options).includes('never-forward-refresh-fixture'), false);
    if (upstreamMode === 'throw') throw new Error('private-access-fixture private upstream detail');
    if (upstreamMode === 'error') return new Response('private-access-fixture', { status: 401 });
    if (upstreamMode === 'json') return new Response('{}', { headers: { 'content-type': 'application/json' } });
    if (upstreamMode === 'missing-type' || upstreamMode === 'missing-type-html') {
      const bytes = new TextEncoder().encode(upstreamMode === 'missing-type' ? 'event: response.completed\ndata: {}\n\n' : '<html>private-access-fixture</html>');
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }));
    }
    if (upstreamMode === 'hold') await new Promise(resolve => { held = resolve; });
    return new Response('data: {"type":"response.completed"}\n\n', {
      headers: { 'content-type': 'text/event-stream', 'set-cookie': 'private-access-fixture', 'x-private-token': 'private-access-fixture' },
    });
  },
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const request = (value = body, options = {}) => fetch(base + (options.path || '/v1/responses'), {
  method: options.method || 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...options.headers },
  ...(options.method === 'GET' ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }),
});
try {
  for (const upstreamUrl of ['http://api.openai.com/v1/responses', 'https://evil.test/v1/responses', 'https://api.openai.com/v1/responses?url=evil', 'https://user:pass@api.openai.com/v1/responses']) {
    assert.throws(() => createReviewResponsesGateway({ clientKey: key, upstreamUrl, getAccessCredential: async () => ({}) }));
  }
  assert.equal((await request(body, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await request(body, { path: '/v1/responses?url=https://evil.test' })).status, 404);
  assert.equal((await request(body, { path: '/admin' })).status, 404);
  assert.equal((await request({ ...body, model: 'other-model' })).status, 403);
  assert.equal((await request({ ...body, store: true })).status, 400);
  assert.equal((await request({ ...body, stream: false })).status, 400);
  assert.equal((await request('not-json')).status, 400);
  assert.equal((await request('x'.repeat(2049))).status, 413);
  assert.equal(calls, 0); assert.equal(credentials, 0);
  const catalog = await request(null, { method: 'GET', path: '/v1/models' });
  assert.deepEqual((await catalog.json()).data.map(m => m.id), [REVIEW_MODEL]);
  const success = await request(body, { headers: { cookie: 'attacker', 'chatgpt-account-id': 'attacker', 'x-forwarded-host': 'evil.test' } });
  assert.equal(success.status, 200);
  assert.equal(success.headers.get('set-cookie'), null);
  assert.equal(success.headers.get('x-private-token'), null);
  assert.match(await success.text(), /response.completed/);
  upstreamMode = 'missing-type';
  const missingType = await request(); assert.equal(missingType.status, 200); assert.match(await missingType.text(), /response.completed/);
  for (const mode of ['throw', 'error', 'json', 'missing-type-html']) {
    upstreamMode = mode;
    const result = await request();
    assert.ok(result.status >= 500);
    assert.equal((await result.text()).includes('private-access-fixture'), false);
  }
  upstreamMode = 'hold';
  const pending = request();
  while (!held) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await request()).status, 429);
  held(); const completed = await pending; assert.equal(completed.status, 200); await completed.text();
  console.log('PASS fixed Luna gateway: real HTTP routes/auth/body/model bounds, credential isolation, SSE, safe failures, no redirects, concurrency limit');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}

const timed = createReviewResponsesGateway({ clientKey: key,
  upstreamUrl: 'https://api.openai.com/v1/responses', timeoutMs: 40, maxConcurrent: 1,
  getAccessCredential: () => new Promise(() => {}), fetchImpl: () => { throw new Error('Must not reach upstream'); },
});
timed.listen(0, '127.0.0.1'); await once(timed, 'listening');
try {
  for (let i = 0; i < 2; i++) {
    const result = await fetch(`http://127.0.0.1:${timed.address().port}/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body),
    });
    assert.equal(result.status, 503); await result.text();
  }
  console.log('PASS credential-owner timeout releases concurrency without starting another OAuth owner');
} finally { timed.closeAllConnections(); await new Promise(resolve => timed.close(resolve)); }
