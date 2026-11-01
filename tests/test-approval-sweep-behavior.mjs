#!/usr/bin/env node
// Behavior test for the stale-approval sweeps (2026-08-08, 7e919f5):
// pending approval_request events whose run is already terminal must receive
// a cancelled approval_response via the session sweep / boot backfill, so
// cards cannot re-pop after the run is gone. Running runs must be untouched.
// Regression for the pre-fix leak: f43b83d8 accumulated 154 pending approvals
// with no response because finalize never looked at session history.
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'agentoc-approval-sweep-'));
const previousEnv = {
  HOME: process.env.HOME,
  AGENTOC_CONFIG_DIR: process.env.AGENTOC_CONFIG_DIR,
  AGENTOC_WORK_ROOT_DIR: process.env.AGENTOC_WORK_ROOT_DIR,
};

process.env.HOME = home;
process.env.AGENTOC_CONFIG_DIR = join(home, '.config', 'agentoc');
process.env.AGENTOC_WORK_ROOT_DIR = join(home, '.agentoc', 'workspace');
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';

function restoreEnv() {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

try {
  const {
    sweepStaleApprovalsAcrossSessions,
    createSession,
  } = await import('../chat/session-manager.mjs');
  const { loadHistory, appendEvent } = await import('../chat/history.mjs');
  const { createRun, updateRun } = await import('../chat/runs.mjs');

  // Two runs: one terminal (leak source), one still running (must survive).
  const terminalRun = await createRun({
    status: {
      sessionId: 'session_sweep_terminal',
      requestId: 'req-sweep-terminal',
      state: 'accepted',
      tool: 'claude-bidi',
    },
    manifest: {
      sessionId: 'session_sweep_terminal',
      requestId: 'req-sweep-terminal',
      folder: '~',
      tool: 'claude-bidi',
      runtimeFamily: 'claude-stream-json-bidi',
      prompt: 'hi',
      options: { runtimeFamily: 'claude-stream-json-bidi' },
    },
  });
  await updateRun(terminalRun.id, (current) => ({ ...current, state: 'completed' }));

  const runningRun = await createRun({
    status: {
      sessionId: 'session_sweep_running',
      requestId: 'req-sweep-running',
      state: 'accepted',
      tool: 'claude-bidi',
    },
    manifest: {
      sessionId: 'session_sweep_running',
      requestId: 'req-sweep-running',
      folder: '~',
      tool: 'claude-bidi',
      runtimeFamily: 'claude-stream-json-bidi',
      prompt: 'hi',
      options: { runtimeFamily: 'claude-stream-json-bidi' },
    },
  });

  // Session A: two pending approvals from the terminal run — one already
  // responded (must NOT be cancelled again), one leaked (must be cancelled).
  const sessionA = (await createSession(home, 'claude-bidi', 'sweep-a')).id;
  await appendEvent(sessionA, {
    type: 'approval_request',
    approvalId: 'claude:sweep-leak-1',
    runId: terminalRun.id,
    status: 'pending',
    ts: new Date().toISOString(),
  });
  await appendEvent(sessionA, {
    type: 'approval_response',
    approvalId: 'claude:sweep-leak-1',
    decision: 'approved',
    runId: terminalRun.id,
    ts: new Date().toISOString(),
  });
  await appendEvent(sessionA, {
    type: 'approval_request',
    approvalId: 'claude:sweep-leak-2',
    runId: terminalRun.id,
    status: 'pending',
    ts: new Date().toISOString(),
  });

  // Session B: pending approval from the STILL-RUNNING run — must survive.
  const sessionB = (await createSession(home, 'claude-bidi', 'sweep-b')).id;
  await appendEvent(sessionB, {
    type: 'approval_request',
    approvalId: 'claude:sweep-live-1',
    runId: runningRun.id,
    status: 'pending',
    ts: new Date().toISOString(),
  });

  const cancelled = await sweepStaleApprovalsAcrossSessions();

  const historyA = await loadHistory(sessionA, { includeBodies: false });
  const cancelledInA = historyA.filter(
    (e) => e.type === 'approval_response' && e.decision === 'cancelled',
  );
  assert.equal(cancelledInA.length, 1, 'exactly the leaked pending approval must be cancelled');
  assert.equal(cancelledInA[0].approvalId, 'claude:sweep-leak-2');
  assert.equal(cancelledInA[0].source, 'boot-backfill');
  assert.equal(cancelledInA[0].runId, terminalRun.id, 'cancellation must carry the owning run id');

  const historyB = await loadHistory(sessionB, { includeBodies: false });
  assert.equal(
    historyB.filter((e) => e.type === 'approval_response' && e.decision === 'cancelled').length,
    0,
    'pending approvals of a still-running run must never be cancelled',
  );
  assert.equal(cancelled >= 1, true, 'sweep must report the number of cancellations');

  console.log('test-approval-sweep-behavior: ok');
} catch (error) {
  console.error('test-approval-sweep-behavior: FAILED');
  console.error(error);
  process.exitCode = 1;
} finally {
  restoreEnv();
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}
