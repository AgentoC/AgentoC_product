import assert from 'node:assert/strict';
import { createDetachedRunReconciler } from '../chat/run-reconciler.mjs';
import { activeWindowsServiceRequest } from '../chat/windows-service-activity.mjs';

let now = Date.parse('2026-09-04T00:00:00Z');
let run = { id: 'run', sessionId: 'session', state: 'running', runnerProcessId: process.pid,
  runnerHeartbeatAt: new Date(now - 600_000).toISOString(),
  windowsServiceRequests: { request: { requestId: 'request', status: 'awaiting_device', startedMs: now - 1000, expiresMs: now + 5000 } } };
let stalled = 0;
const reconcile = createDetachedRunReconciler({
  appendRunSpoolRecord: async () => {}, collectRunOutputPreview: async () => '', graceMs: 0,
  isTerminalRunState: state => ['completed', 'failed', 'cancelled'].includes(state),
  nowIso: () => new Date(now).toISOString(), nowMs: () => now, stallAfterMs: 300_000,
  shouldSkipRunnerStall: current => Boolean(activeWindowsServiceRequest(current, now)),
  onRunnerStalled: async () => { stalled++; return { ...run, cancelRequested: true }; },
  updateRun: async (_id, updater) => { run = updater({ ...run }) || run; return run; },
  writeRunResult: async () => { throw new Error('unexpected synthesized result'); },
});
await reconcile(run.id, run);
assert.equal(stalled, 0, 'an active device approval must not be killed as a stalled runner');
now += 5000;
await reconcile(run.id, run);
assert.equal(stalled, 1, 'an expired approval must not hide a genuinely stalled runner forever');
console.log('windows-service-activity-reconcile: ok');
