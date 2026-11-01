import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactMobileDurableEvents } from '../chat/session-api-shapes.mjs';

test('mobile durable event projection removes only repeated run capability metadata', () => {
  const capabilities = { runtimeFamily: 'codex', supportsSteer: true, extra: 'x'.repeat(20_000) };
  const events = [
    { seq: 1, type: 'message', role: 'user', content: 'hello', providerCapabilities: capabilities },
    { seq: 2, type: 'tool_result', toolOutput: { text: 'result', providerCapabilities: { retained: true } }, providerCapabilities: capabilities },
    { seq: 3, type: 'message', text: 'done' },
  ];
  const result = compactMobileDurableEvents(events);
  assert.deepEqual(result, [
    { seq: 1, type: 'message', role: 'user', content: 'hello' },
    { seq: 2, type: 'tool_result', toolOutput: { text: 'result', providerCapabilities: { retained: true } } },
    events[2],
  ]);
  assert.equal(events[0].providerCapabilities, capabilities, 'projection must not mutate stored events');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 500);
});
