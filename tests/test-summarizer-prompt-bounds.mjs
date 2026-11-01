#!/usr/bin/env node
import assert from 'assert/strict';
import { formatEventsForPrompt } from '../chat/summarizer.mjs';

const events = [
  { type: 'message', role: 'user', content: 'original user request' },
];

for (let index = 0; index < 500; index += 1) {
  events.push({
    type: 'tool_result',
    toolName: 'shell',
    output: `huge output ${index} ${'x'.repeat(2000)}`,
  });
}

events.push({
  type: 'message',
  role: 'assistant',
  bodyPreview: 'final assistant preview',
});

const text = formatEventsForPrompt(events, {
  maxEvents: 12,
  maxTotalChars: 2200,
  toolResultLimit: 500,
  assistantLimit: 500,
});

assert.ok(
  text.length <= 2400,
  'summarizer prompt event text should stay bounded even for huge turns',
);
assert.match(
  text,
  /earlier events omitted by AgentoC/,
  'summarizer prompt should make event omission explicit',
);
assert.match(
  text,
  /USER: original user request/,
  'summarizer prompt should preserve the first user request',
);
assert.match(
  text,
  /truncated by AgentoC|ASSISTANT: final assistant preview/,
  'summarizer prompt should either include the latest assistant preview or explicitly mark truncation',
);

console.log('test-summarizer-prompt-bounds: ok');
