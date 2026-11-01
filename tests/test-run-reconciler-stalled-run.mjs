import assert from 'node:assert/strict';
import { createDetachedRunReconciler } from '../chat/run-reconciler.mjs';

const nowMs = Date.parse('2026-09-04T00:00:00.000Z');
const staleHeartbeat = new Date(nowMs - 10 * 60 * 1000).toISOString();
let storedRun = {
  id: 'run_reconciler_stalled',
  sessionId: 'session_reconciler_stalled',
  state: 'running',
  runnerProcessId: process.pid,
  runnerHeartbeatAt: staleHeartbeat,
};
let stalledCalls = 0;
const reconcile = createDetachedRunReconciler({
  appendRunSpoolRecord: async () => {},
  collectRunOutputPreview: async () => '',
  graceMs: 0,
  isTerminalRunState: (state) => ['completed', 'failed', 'cancelled'].includes(state),
  nowIso: () => '2026-09-04T00:00:00.000Z',
  nowMs: () => nowMs,
  onRunnerStalled: async ({ heartbeatAgeMs, staleAfterMs }) => {
    stalledCalls += 1;
    assert.ok(heartbeatAgeMs >= staleAfterMs);
    storedRun = {
      ...storedRun,
      cancelRequested: true,
      stalledAt: '2026-09-04T00:00:00.000Z',
    };
    return storedRun;
  },
  stallAfterMs: 5 * 60 * 1000,
  updateRun: async (_id, updater) => {
    storedRun = updater({ ...storedRun }) || storedRun;
    return storedRun;
  },
  writeRunResult: async () => {
    throw new Error('stalled run must not be terminalized by the detector');
  },
});

const stalled = await reconcile(storedRun.id, storedRun);
assert.equal(stalledCalls, 1);
assert.equal(stalled.cancelRequested, true);
assert.equal(stalled.stalledAt, '2026-09-04T00:00:00.000Z');
assert.equal(stalled.state, 'running', 'detector should let the sidecar produce terminal evidence');

await reconcile(storedRun.id, storedRun);
assert.equal(stalledCalls, 1, 'cancellation request must be idempotent');

console.log('test-run-reconciler-stalled-run: passed');
