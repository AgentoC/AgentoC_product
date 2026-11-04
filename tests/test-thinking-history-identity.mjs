import assert from 'node:assert/strict';
import { buildSessionDisplayEvents } from '../chat/session-display-events.mjs';

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
console.log('Thinking blocks preserve identity, order and complete snapshots');
