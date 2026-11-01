#!/usr/bin/env node
// Regression: concurrent observer ticks and a process restart must settle one
// missing-result terminal outcome, with no duplicate diagnostic spool record.
import assert from 'assert/strict';
import { createDetachedRunReconciler } from '../chat/run-reconciler.mjs';

const runId = 'run_reconciler_idempotent';
const completedAt = '2026-08-13T02:03:04.000Z';
let storedRun = {
  id: runId,
  sessionId: 'session_reconciler_idempotent',
  state: 'running',
  runnerProcessId: 2_000_000_000,
  missingResultDetectedAt: '2020-01-01T00:00:00.000Z',
};
const spoolRecords = [];
const resultWrites = [];

const reconcile = createDetachedRunReconciler({
  appendRunSpoolRecord: async (_id, record) => { spoolRecords.push(record); },
  collectRunOutputPreview: async () => 'last output',
  graceMs: 0,
  isTerminalRunState: (state) => ['completed', 'failed', 'cancelled'].includes(state),
  nowIso: () => completedAt,
  updateRun: async (_id, updater) => {
    const draft = { ...storedRun };
    const next = updater(draft) || draft;
    if (next !== draft) storedRun = next;
    return { ...storedRun };
  },
  writeRunResult: async (_id, result) => { resultWrites.push(result); },
});

const [first, second] = await Promise.all([
  reconcile(runId, { ...storedRun }),
  reconcile(runId, { ...storedRun }),
]);

assert.equal(storedRun.state, 'failed', 'missing-result recovery settles one terminal state');
assert.equal(storedRun.result?.reconciledMissingResult, true, 'terminal state records its synthetic recovery result');
assert.equal(storedRun.completedAt, completedAt, 'competing passes retain one stable completion timestamp');
assert.equal(spoolRecords.length, 1, 'competing passes append exactly one missing-result diagnostic');
assert.equal(resultWrites.length, 1, 'competing passes write exactly one result file');
assert.equal(first?.result?.completedAt, completedAt, 'winning pass returns the settled run');
assert.equal(second?.result?.completedAt, completedAt, 'losing pass observes the same settled run');

// Simulate a restart after status.json was committed but before result.json.
// The status-held result is replayed verbatim; no transition or extra spool
// diagnostic is made, and the synthetic result remains stable.
const recoveredAfterRestart = await reconcile(runId, { ...storedRun });
assert.equal(recoveredAfterRestart?.state, 'failed', 'terminal status remains terminal on restart');
assert.equal(resultWrites.length, 2, 'restart repairs the missing result file from status');
assert.deepEqual(resultWrites[1], resultWrites[0], 'restart repair replays the identical synthetic result');
assert.equal(spoolRecords.length, 1, 'restart repair never emits a duplicate diagnostic');

console.log('test-run-reconciler-idempotent-recovery: ok');
