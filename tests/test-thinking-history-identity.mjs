import assert from 'node:assert/strict';
import { buildSessionDisplayEvents } from '../chat/session-display-events.mjs';
import { getProviderEventReplayKey } from '../chat/provider-event-dedup.mjs';

const events = [
  { seq: 1, type: 'message', role: 'user', content: 'Question', runId: 'r' },
  { seq: 2, type: 'reasoning', runId: 'r', providerMessageId: 'm', providerBlockId: 'thinking:0', state: 'running', content: 'Hel' },
  { seq: 3, type: 'reasoning', runId: 'r', providerMessageId: 'm', providerBlockId: 'thinking:0', state: 'running', content: 'lo' },
  { seq: 4, type: 'reasoning', runId: 'r', providerMessageId: 'm', providerBlockId: 'thinking:0', state: 'completed', content: 'Hello' },
  { seq: 5, type: 'message', role: 'assistant', runId: 'r', providerMessageId: 'm', content: 'Reply' },
  { seq: 6, type: 'reasoning', runId: 'r', providerMessageId: 'm2', providerBlockId: 'thinking:0', state: 'completed', content: 'Later' },
  { seq: 7, type: 'reasoning', runId: 'r2', providerMessageId: 'm3', providerBlockId: 'thinking:0', state: 'completed', content: 'Other run' },
];
const display = buildSessionDisplayEvents(events);
assert.deepEqual(display.map((event) => event.type), ['message', 'thinking_block', 'message', 'thinking_block', 'thinking_block']);
assert.deepEqual(display.filter((event) => event.type === 'thinking_block').map((event) => [event.runId, event.content]),
  [['r', 'Hello'], ['r', 'Later'], ['r2', 'Other run']]);
assert.equal(display[1].providerBlockId, 'thinking:0');
const rebased = buildSessionDisplayEvents([
  { seq: 4, type: 'reasoning', runId: 'r', providerMessageId: 'm', providerBlockId: 'thinking:0', state: 'completed', content: 'Before' },
  { seq: 8, firstSeq: 3, type: 'message', role: 'assistant', runId: 'r', providerMessageId: 'm', providerContentBlockIndex: 1, content: 'Reply' },
]);
assert.deepEqual(rebased.map((event) => event.type), ['message', 'thinking_block']);
assert.equal(rebased[1].seq, 4);
assert.equal(rebased[1].displaySeq, 3);
assert.equal(rebased[1].beforeAssistantAtSameSeq, true);
const differentRun = buildSessionDisplayEvents([
  { seq: 4, type: 'reasoning', runId: 'other', providerMessageId: 'm', providerBlockId: 'thinking:0', state: 'completed', content: 'Other' },
  { seq: 8, firstSeq: 3, type: 'message', role: 'assistant', runId: 'r', providerMessageId: 'm', providerContentBlockIndex: 1, content: 'Reply' },
]);
assert.deepEqual(differentRun.map((event) => event.type), ['message', 'thinking_block']);
const reasoningKey = (block) => getProviderEventReplayKey({ type: 'reasoning', runId: 'r',
  providerMessageId: 'm', providerBlockId: block, content: 'same text' });
assert.notEqual(reasoningKey('thinking:0'), reasoningKey('thinking:1'));
console.log('Thinking blocks preserve identity, order and complete snapshots');
