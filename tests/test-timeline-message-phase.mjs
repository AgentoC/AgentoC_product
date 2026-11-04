import assert from 'node:assert/strict';
import { createClaudeAdapter } from '../chat/adapters/claude.mjs';
import { createCodexAppServerAdapter } from '../chat/adapters/codex-app-server.mjs';

for (const [stopReason, phase] of [['tool_use', 'commentary'], ['end_turn', 'final_answer'], [null, undefined]]) {
  const events = createClaudeAdapter().parseLine(JSON.stringify({ type: 'assistant', message: {
    id: 'msg-1', stop_reason: stopReason, content: [{ type: 'text', text: 'Example' }],
  } }));
  assert.equal(events.find((event) => event.type === 'message')?.messagePhase, phase);
}
const streamed = createClaudeAdapter();
streamed.parseLine(JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'streamed' } } }));
streamed.parseLine(JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } }));
const snapshot = streamed.parseLine(JSON.stringify({ type: 'assistant', message: {
  id: 'streamed', stop_reason: null, content: [{ type: 'text', text: 'Done' }],
} }));
assert.equal(snapshot.find((event) => event.type === 'message')?.messagePhase, 'final_answer');
for (const phase of ['commentary', 'final_answer']) {
  const events = createCodexAppServerAdapter().parseLine(JSON.stringify({ method: 'item/completed', params: {
    item: { id: 'item-1', type: 'agentMessage', phase, text: 'Example' },
  } }));
  assert.equal(events.find((event) => event.type === 'message')?.messagePhase, phase);
}
console.log('Provider message phases preserved');
