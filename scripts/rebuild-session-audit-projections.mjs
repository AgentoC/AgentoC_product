#!/usr/bin/env node
import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';

import { CHAT_HISTORY_DIR } from '../lib/config.mjs';
import { readEventsAfter } from '../chat/history.mjs';
import { buildSessionAuditProjection, writeSessionAuditProjection } from '../chat/session-audit-projection.mjs';

function parseArgs(argv) {
  const options = {
    all: false,
    sessions: [],
    concurrency: 1,
    since: '',
    dryRun: false,
    retries: 3,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') {
      options.all = true;
    } else if (arg === '--session') {
      const sessionId = argv[index + 1] || '';
      index += 1;
      if (sessionId) options.sessions.push(sessionId);
    } else if (arg === '--concurrency') {
      const value = Number.parseInt(argv[index + 1] || '', 10);
      index += 1;
      options.concurrency = Number.isInteger(value) && value > 0 ? value : 1;
    } else if (arg === '--since') {
      options.since = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--retries') {
      const value = Number.parseInt(argv[index + 1] || '', 10);
      index += 1;
      options.retries = Number.isInteger(value) && value >= 0 ? value : 3;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/rebuild-session-audit-projections.mjs [options]

Options:
  --session <id>       Rebuild one session. Can be passed multiple times.
  --all                Rebuild every session under CHAT_HISTORY_DIR.
  --concurrency <n>    Process sessions concurrently. Defaults to 1.
  --since <timestamp>  With --all, skip sessions whose meta lastEventAt is older.
  --dry-run            Report projection counts without writing audit-projection.json.
  --retries <n>        Retry if the session changes while rebuilding. Defaults to 3.
`);
}

async function readMeta(sessionId) {
  try {
    return JSON.parse(await readFile(join(CHAT_HISTORY_DIR, sessionId, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function listAllSessionIds({ since = '' } = {}) {
  const entries = await readdir(CHAT_HISTORY_DIR, { withFileTypes: true });
  const sinceMs = since ? Date.parse(since) : 0;
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionId = entry.name;
    const metaPath = join(CHAT_HISTORY_DIR, sessionId, 'meta.json');
    const metaStat = await stat(metaPath).catch(() => null);
    if (!metaStat) continue;
    if (sinceMs > 0) {
      const meta = await readMeta(sessionId);
      const lastEventAt = Number(meta?.lastEventAt || 0);
      const metaTime = lastEventAt > 0 ? lastEventAt : metaStat.mtimeMs;
      if (metaTime < sinceMs) continue;
    }
    ids.push(sessionId);
  }
  return ids.sort();
}

async function rebuildOne(sessionId, { dryRun = false, retries = 3 } = {}) {
  let attempt = 0;
  let beforeMeta = null;
  let afterMeta = null;
  let events = [];
  while (attempt <= retries) {
    beforeMeta = await readMeta(sessionId);
    const beforeLatestSeq = Number.isInteger(beforeMeta?.latestSeq) ? beforeMeta.latestSeq : 0;
    events = await readEventsAfter(sessionId, 0, {
      includeBodies: false,
      includeMessageBodies: true,
    });
    afterMeta = await readMeta(sessionId);
    const afterLatestSeq = Number.isInteger(afterMeta?.latestSeq) ? afterMeta.latestSeq : 0;
    if (beforeLatestSeq === afterLatestSeq) break;
    attempt += 1;
    if (attempt > retries) {
      throw new Error(`session changed during projection rebuild: ${sessionId} (${beforeLatestSeq} -> ${afterLatestSeq})`);
    }
  }
  const latestSeq = Number.isInteger(afterMeta?.latestSeq) ? afterMeta.latestSeq : 0;
  const projection = buildSessionAuditProjection(sessionId, events, { latestSeq });
  if (projection.sourceLatestSeq !== latestSeq) {
    throw new Error(`projection latest seq mismatch for ${sessionId}: projection=${projection.sourceLatestSeq} meta=${latestSeq}`);
  }
  if (!dryRun) {
    await writeSessionAuditProjection(sessionId, projection);
  }
  return {
    sessionId,
    sourceLatestSeq: projection.sourceLatestSeq,
    artifactFiles: projection.artifactFiles.length,
    changedFiles: projection.changedFiles.length,
    progressPlans: projection.progressPlans.length,
    dryRun,
    attempts: attempt + 1,
  };
}

async function runPool(items, concurrency, worker) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || (!options.all && options.sessions.length === 0)) {
    printHelp();
    process.exit(options.help ? 0 : 1);
  }
  const sessions = options.all
    ? await listAllSessionIds({ since: options.since })
    : Array.from(new Set(options.sessions));
  const results = await runPool(
    sessions,
    options.concurrency,
    (sessionId) => rebuildOne(sessionId, { dryRun: options.dryRun, retries: options.retries }),
  );
  for (const result of results) {
    console.log(JSON.stringify(result));
  }
  console.error(`rebuilt ${results.length} session audit projection(s)${options.dryRun ? ' (dry-run)' : ''}`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
