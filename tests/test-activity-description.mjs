import assert from 'node:assert/strict';
import { formatToolCall } from '../chat/tool-call-formatters.mjs';
import { buildRunActivityProjection } from '../chat/run-activity-projection.mjs';

const presentation = formatToolCall({ kind: 'execute' }, {
  input: { command: 'cat README.md', description: 'Check the project instructions' },
});
assert.equal(presentation.activityDescription, 'Check the project instructions');
assert.equal(formatToolCall({ kind: 'read' }, { input: { description: 'unrelated' } }).activityDescription, undefined);
const secret = formatToolCall({ kind: 'execute' }, {
  input: { description: 'Check API_TOKEN=do-not-display' },
});
assert.equal(secret.activityDescription.includes('do-not-display'), false);
const activity = buildRunActivityProjection([{
  type: 'operation', operationId: 'op', state: 'running', seq: 1, presentation,
}], { sessionRunning: true, run: { id: 'r' } });
assert.equal(activity.activityDescription, 'Check the project instructions');
console.log('Activity descriptions are projected with redaction');
