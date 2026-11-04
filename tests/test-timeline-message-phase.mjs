import assert from 'node:assert/strict';
import { createCodexAdapter } from '../chat/adapters/codex.mjs';
import { createClaudeAdapter } from '../chat/adapters/claude.mjs';
import { createCodexAppServerAdapter } from '../chat/adapters/codex-app-server.mjs';
import { buildSessionDisplayEvents } from '../chat/session-display-events.mjs';

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
  const message = events.find((event) => event.type === 'message');
  const visible = buildSessionDisplayEvents([{ ...message, seq: 1, runId: 'r' }]);
  assert.equal(visible.find((event) => event.type === 'message')?.messagePhase, phase);
}
const codexThinking = createCodexAppServerAdapter().parseLine(JSON.stringify({ method: 'item/completed', params: {
  item: { id: 'reasoning-1', type: 'reasoning', summary: ['Inspecting the results'] },
} })).find((event) => event.type === 'reasoning');
assert.equal(codexThinking?.reasoningLifecycle, 'completed');
assert.equal(codexThinking?.providerMessageId, 'reasoning-1');
const streamedThinking = createCodexAppServerAdapter();
const firstReasoning = streamedThinking.parseLine(JSON.stringify({ method: 'item/reasoning/summaryTextDelta',
  params: { itemId: 'reasoning-stream', summaryIndex: 0, delta: 'Inspecting ' },
})).find((event) => event.type === 'reasoning');
streamedThinking.parseLine(JSON.stringify({ method: 'item/reasoning/summaryTextDelta',
  params: { itemId: 'reasoning-stream', summaryIndex: 0, delta: 'changes' },
}));
const recoveredThinking = streamedThinking.parseLine(JSON.stringify({ method: 'item/completed',
  params: { item: { id: 'reasoning-stream', type: 'reasoning', summary: [] } },
})).find((event) => event.type === 'reasoning');
assert.equal(firstReasoning?.providerMessageId, recoveredThinking?.providerMessageId);
assert.equal(recoveredThinking?.content, 'Inspecting changes');
assert.equal(recoveredThinking?.reasoningLifecycle, 'completed');
streamedThinking.parseLine(JSON.stringify({ method: 'item/reasoning/summaryTextDelta',
  params: { itemId: 'a', summaryIndex: 1, delta: 'second' },
}));
streamedThinking.parseLine(JSON.stringify({ method: 'item/reasoning/summaryTextDelta',
  params: { itemId: 'a', summaryIndex: 0, delta: 'first' },
}));
streamedThinking.parseLine(JSON.stringify({ method: 'item/reasoning/summaryTextDelta',
  params: { itemId: 'b', summaryIndex: 0, delta: 'other' },
}));
const completeA = streamedThinking.parseLine(JSON.stringify({ method: 'item/completed',
  params: { item: { id: 'a', type: 'reasoning' } },
})).find((event) => event.type === 'reasoning');
const completeB = streamedThinking.parseLine(JSON.stringify({ method: 'item/completed',
  params: { item: { id: 'b', type: 'reasoning' } },
})).find((event) => event.type === 'reasoning');
assert.equal(completeA?.content, 'first\n\nsecond');
assert.equal(completeB?.content, 'other');
const codexCliThinking = createCodexAdapter().parseLine(JSON.stringify({ type: 'item.completed',
  item: { id: 'reasoning-cli', type: 'reasoning', text: 'Inspecting changes' },
})).find((event) => event.type === 'reasoning');
assert.equal(codexCliThinking?.reasoningLifecycle, 'completed');
console.log('Provider message phases and completed reasoning preserved');
