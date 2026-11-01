import assert from 'node:assert/strict';
import { assertContinuityProgress, buildContinuityCheckpoint, createInitialContinuityState, reduceContinuityEvents, validateContinuityState } from '../chat/continuity-core.mjs';

const events = [
  { seq: 1, type: 'message', role: 'user', content: 'Automate the weekly report.' },
  { seq: 2, type: 'file_change', filePath: 'report.csv', changeType: 'update' },
  { seq: 3, type: 'tool_result', toolName: 'npm test', output: 'ok', exitCode: 0 },
  { seq: 4, type: 'run_completed', runId: 'run-1', status: 'completed' },
];
const all = reduceContinuityEvents('session-1', events);
validateContinuityState(all);
assert.equal(all.revision, 4);
assert.equal(all.coverage.coveredThroughSeq, 4);
assert.equal(all.coverage.omittedRanges.length, 0);
assert.equal(all.objective.raw, 'Automate the weekly report.');
assert.equal(all.files[0].path, 'report.csv');
assert.equal(all.validations[0].exitCode, 0);
const checkpoint = buildContinuityCheckpoint(all, { expectedRevision: 4 });
assert.equal(checkpoint.schemaVersion, 2);
assert.equal(checkpoint.task.goal.text, 'Automate the weekly report.');
assert.equal(checkpoint.execution.files[0].path, 'report.csv');
assert.equal(checkpoint.execution.validations[0].state, 'passed');
assert.doesNotThrow(() => assertContinuityProgress(createInitialContinuityState('session-1'), checkpoint));
assert.throws(() => buildContinuityCheckpoint(all, { expectedRevision: 3 }), /revision mismatch/);
const withGap = reduceContinuityEvents('session-1', [events[0], events[2]]);
assert.deepEqual(withGap.coverage.omittedRanges, [{ from: 2, to: 2 }]);
assert.throws(() => validateContinuityState({ ...withGap, revision: 99 }), /diverged/);
assert.throws(() => assertContinuityProgress(checkpoint, withGap), /revision regressed/);
assert.deepEqual(reduceContinuityEvents('session-1', events), reduceContinuityEvents('session-1', [...events.slice(0, 2), ...events.slice(2)]));
console.log('test-continuity-core: ok');
