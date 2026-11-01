#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  buildClineArgs,
  createClineAdapter,
  CLINE_RUNTIME_FAMILY,
} from '../chat/adapters/cline.mjs';

assert.deepEqual(buildClineArgs('Do the work.'), ['--json', '--yolo', 'Do the work.']);
assert.deepEqual(buildClineArgs('Review the workspace.', { riskMode: 'conservative-auto' }), [
  '--json', '--auto-approve', 'false', 'Review the workspace.',
]);
assert.deepEqual(buildClineArgs('Continue.', {
  provider: 'openai-native',
  model: 'gpt-5@provider-a',
  resume: 'cline-session-1',
}), [
  '--json', '--yolo', '--id', 'cline-session-1', '--provider', 'openai-native',
  '--model', 'gpt-5', 'Continue.',
]);

const adapter = createClineAdapter();
assert.equal(adapter.capabilities.provider, 'cline');
assert.equal(adapter.capabilities.runtimeFamily, CLINE_RUNTIME_FAMILY);
assert.equal(adapter.capabilities.supportsResume, true);

const parse = (payload) => adapter.parseLine(JSON.stringify(payload));
const event = (type, extra = {}) => ({
  type: 'agent_event',
  sessionId: 'cline-session-1',
  event: { type, sessionId: 'cline-session-1', ...extra },
});

const textDelta = parse(event('content_update', {
  contentType: 'text',
  text: 'hello',
}));
assert.equal(textDelta[0].type, 'text_delta');
assert.equal(textDelta[0].text, 'hello');
assert.equal(textDelta[0].providerSessionId, 'cline-session-1');

const realTextStart = parse({
  type: 'agent_event',
  payload: {
    sessionId: 'cline-session-real',
    event: { type: 'content_start', contentType: 'text', text: 'first chunk' },
  },
});
assert.equal(realTextStart[0].type, 'text_delta');
assert.equal(realTextStart[0].text, 'first chunk');
assert.equal(realTextStart[0].providerSessionId, 'cline-session-real');

const realReasoningStart = parse({
  type: 'agent_event',
  payload: {
    sessionId: 'cline-session-real',
    event: { type: 'content_start', contentType: 'reasoning', reasoning: 'first thought' },
  },
});
assert.equal(realReasoningStart[0].type, 'reasoning');
assert.equal(realReasoningStart[0].content, 'first thought');

const message = parse(event('content_end', {
  contentType: 'text',
  text: 'hello',
}));
assert.equal(message[0].type, 'message');
assert.equal(message[0].role, 'assistant');
assert.equal(message[0].content, 'hello');

const reasoning = parse(event('content_update', {
  contentType: 'reasoning',
  text: 'thinking',
}));
assert.equal(reasoning[0].type, 'reasoning');
assert.equal(reasoning[0].content, 'thinking');

const usage = parse({
  type: 'agent_event',
  payload: {
    sessionId: 'cline-session-real',
    event: {
      type: 'usage', inputTokens: 120, outputTokens: 40,
      cacheReadTokens: 12, totalInputTokens: 240, totalOutputTokens: 80,
    },
  },
});
assert.equal(usage[0].type, 'usage');
assert.equal(usage[0].inputTokens, 120);
assert.equal(usage[0].outputTokens, 40);
assert.equal(usage[0].cachedInputTokens, 12);
assert.equal(usage[0].providerSessionId, 'cline-session-real');

const toolUse = parse(event('content_start', {
  contentType: 'tool',
  toolName: 'shell',
  toolCallId: 'call-1',
  input: { command: 'echo ok' },
}));
assert.equal(toolUse[0].type, 'tool_use');
assert.equal(toolUse[0].toolName, 'shell');
assert.equal(toolUse[0].providerToolUseId, 'call-1');

const toolResult = parse(event('content_end', {
  contentType: 'tool',
  toolName: 'shell',
  toolCallId: 'call-1',
  output: 'ok',
}));
assert.equal(toolResult[0].type, 'tool_result');
assert.equal(toolResult[0].output, 'ok');
assert.equal(toolResult[0].exitCode, 0);

const done = parse(event('done'));
assert.equal(done[0].type, 'status');
assert.equal(done[0].content, 'completed');
assert.equal(adapter.parseLine('{not-json}').length, 0);

console.log('Cline adapter tests passed');
