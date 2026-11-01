#!/usr/bin/env node
import assert from 'assert/strict';
import { createClaudeAdapter } from '../chat/adapters/claude.mjs';

const sessionId = 'claude-fixture-session';
const lines = [
  { type: 'system', subtype: 'init', session_id: sessionId },
  { type: 'system', subtype: 'status', status: 'requesting', session_id: sessionId },
  { type: 'system', subtype: 'thinking_tokens', session_id: sessionId },
  {
    type: 'stream_event',
    session_id: sessionId,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Inspect' } },
  },
  {
    type: 'assistant',
    session_id: sessionId,
    message: { id: 'msg-thinking', content: [{ type: 'thinking', thinking: 'Inspect files.' }] },
  },
  {
    type: 'stream_event',
    session_id: sessionId,
    event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done' } },
  },
  {
    type: 'assistant',
    session_id: sessionId,
    message: { id: 'msg-final', content: [{ type: 'text', text: 'Done.' }] },
  },
  {
    type: 'stream_event',
    session_id: sessionId,
    event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
  },
  {
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    result: 'Done.',
    total_cost_usd: 0.01,
    usage: { input_tokens: 20, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 8 },
  },
];

function stable(events) {
  return events.map(({ id, timestamp, ...event }) => event);
}

const singleAdapter = createClaudeAdapter();
const onePass = lines.flatMap(line => singleAdapter.parseLine(JSON.stringify(line)));
const pollByPoll = lines.flatMap(line => createClaudeAdapter().parseLine(JSON.stringify(line)));

assert.deepEqual(
  stable(pollByPoll),
  stable(onePass),
  'Claude projection should not depend on adapter state surviving across poll boundaries',
);
assert.deepEqual(
  onePass.map(event => event.type),
  ['status', 'reasoning', 'reasoning', 'text_delta', 'message', 'usage', 'status'],
  'the fixture should retain live reasoning, finalized reasoning, final content, usage, and lifecycle events',
);
assert.equal(onePass.filter(event => event.type === 'reasoning').length, 2);
assert.equal(onePass.find(event => event.reasoningLifecycle === 'delta')?.content, 'Inspect');
assert.equal(onePass.find(event => event.reasoningLifecycle === 'completed')?.content, 'Inspect files.');
assert.equal(onePass.filter(event => event.type === 'message').length, 1);
assert.equal(onePass.filter(event => event.type === 'usage').length, 1);
assert.equal(onePass.some(event => event.content === 'System: thinking_tokens'), false);
assert.equal(onePass.some(event => String(event.content || '').startsWith('stop:')), false);

console.log('test-claude-stream-projection: ok');
