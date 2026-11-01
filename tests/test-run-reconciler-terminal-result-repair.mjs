#!/usr/bin/env node
// Regression: a terminal status projection must repair a result file that was
// lost after status.json was committed, regardless of whether the result was
// synthesized or written by the sidecar's normal terminal path.
import assert from 'assert/strict';
import { createDetachedRunReconciler } from '../chat/run-reconciler.mjs';

const completedAt = '2026-09-02T03:04:05.000Z';
const result = { completedAt, exitCode: 0, signal: null, providerTerminalSeen: true };
let writes = [];

const reconcile = createDetachedRunReconciler({
  appendRunSpoolRecord: async () => {},
  collectRunOutputPreview: async () => '',
  graceMs: 0,
  isTerminalRunState: (state) => ['completed', 'failed', 'cancelled'].includes(state),
  nowIso: () => completedAt,
  updateRun: async (_runId, updater) => updater({
    id: 'run_terminal_result_repair',
    state: 'completed',
    result,
  }),
  writeRunResult: async (_runId, value) => { writes.push(value); },
});

const repaired = await reconcile('run_terminal_result_repair', {
  id: 'run_terminal_result_repair',
  state: 'completed',
  result,
});

assert.equal(repaired?.state, 'completed');
assert.deepEqual(writes, [result], 'normal terminal result should be replayed into result.json');
console.log('test-run-reconciler-terminal-result-repair: ok');
