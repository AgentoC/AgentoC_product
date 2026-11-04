import assert from 'node:assert/strict';
import { buildRunActivityProjection } from '../chat/run-activity-projection.mjs';

const run = { id: 'run-a', requestId: 'request-a', startedAt: 1_000 };
const options = { sessionRunning: true, run, nowMs: 13_500 };
const activity = buildRunActivityProjection([], options);
assert.equal(activity.runId, 'run-a');
assert.equal(activity.requestId, 'request-a');
assert.equal(activity.runElapsedMs, 12_500);
const tool = buildRunActivityProjection([{ type: 'operation', operationId: 'op-1', state: 'running', seq: 2,
  startedAt: 12_000, kind: 'command', title: 'Command', detail: 'cat README.md' }], options);
assert.equal(tool.runElapsedMs, 12_500);
assert.notEqual(tool.since, run.startedAt);
assert.equal(buildRunActivityProjection([], { ...options, nowMs: 500 }).runElapsedMs, undefined);
assert.equal(buildRunActivityProjection([], { sessionRunning: false, run }).runElapsedMs, undefined);
console.log('Run elapsed time is independent of activity');
