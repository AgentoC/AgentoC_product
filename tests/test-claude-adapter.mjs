#!/usr/bin/env node
import assert from 'assert/strict';

import { createClaudeAdapter } from '../chat/adapters/claude.mjs';

const adapter = createClaudeAdapter();
assert.equal(adapter.capabilities.provider, 'claude');
assert.equal(adapter.capabilities.supportsStructuredPlanFallback, true);

const initEvents = adapter.parseLine(JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'claude-session-1',
}));
assert.equal(initEvents.length, 1);
assert.equal(initEvents[0].type, 'status');
assert.equal(initEvents[0].provider, 'claude');
assert.equal(initEvents[0].providerSessionId, 'claude-session-1');

assert.deepEqual(adapter.parseLine(JSON.stringify({
  type: 'system',
  subtype: 'thinking_tokens',
  session_id: 'claude-session-1',
})), []);

assert.deepEqual(adapter.parseLine(JSON.stringify({
  type: 'system',
  subtype: 'status',
  status: 'requesting',
  session_id: 'claude-session-1',
})), []);

const toolEvents = adapter.parseLine(JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: 'I will inspect it.' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Bash',
        input: { command: 'pwd' },
      },
    ],
  },
}));
assert.equal(toolEvents[0].type, 'message');
assert.equal(toolEvents[0].content, 'I will inspect it.');
assert.equal(toolEvents[1].type, 'tool_use');
assert.equal(toolEvents[1].toolName, 'Bash');
assert.equal(toolEvents[1].providerToolUseId, 'toolu_1');
assert.equal(toolEvents[1].operationLifecycle, 'started');

const editEvents = createClaudeAdapter().parseLine(JSON.stringify({
  type: 'assistant',
  message: {
    content: [{
      type: 'tool_use',
      id: 'toolu_edit',
      name: 'Edit',
      input: {
        file_path: '/tmp/example.js',
        old_string: 'const value = 1;\n',
        new_string: 'const value = 2;\nconsole.log(value);\n',
      },
    }],
  },
}));
assert.deepEqual(editEvents.map(event => event.type), ['tool_use', 'file_change']);
assert.equal(editEvents[1].filePath, '/tmp/example.js');
assert.equal(editEvents[1].added, 2);
assert.equal(editEvents[1].removed, 1);
assert.equal(editEvents[1].providerToolUseId, 'toolu_edit');
assert.equal(editEvents[1].sourceToolName, 'Edit');
assert.equal(editEvents[1].operationLifecycle, 'started');
assert.equal(editEvents[1].operationKind, 'file_edit');

const finalizedThinkingEvents = adapter.parseLine(JSON.stringify({
  type: 'assistant',
  message: {
    id: 'msg-thinking',
    content: [{ type: 'thinking', thinking: 'Inspect the relevant files.' }],
  },
}));
assert.equal(finalizedThinkingEvents.length, 1);
assert.equal(finalizedThinkingEvents[0].type, 'reasoning');
assert.equal(finalizedThinkingEvents[0].content, 'Inspect the relevant files.');

const thinkingDeltaEvents = adapter.parseLine(JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'Inspect' },
  },
}));
assert.equal(thinkingDeltaEvents.length, 1);
assert.equal(thinkingDeltaEvents[0].type, 'reasoning');
assert.equal(thinkingDeltaEvents[0].content, 'Inspect');
assert.equal(thinkingDeltaEvents[0].providerBlockId, 'thinking:0');
assert.equal(thinkingDeltaEvents[0].reasoningLifecycle, 'delta');
assert.equal(thinkingDeltaEvents[0].state, 'running');

const textDeltaEvents = adapter.parseLine(JSON.stringify({
  type: 'stream_event',
  uuid: 'claude-stream-event-1',
  session_id: 'claude-session-1',
  event: {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: 'Streamed' },
  },
}));
assert.equal(textDeltaEvents.length, 1);
assert.equal(textDeltaEvents[0].type, 'text_delta');
assert.equal(textDeltaEvents[0].text, 'Streamed');
assert.equal(textDeltaEvents[0].providerEventId, 'claude-stream-event-1:text:1:1');
assert.equal(textDeltaEvents[0].provider, 'claude');
assert.equal(textDeltaEvents[0].runtimeFamily, 'claude-stream-json');

const finalizedTextEvents = createClaudeAdapter().parseLine(JSON.stringify({
  type: 'assistant',
  message: {
    id: 'msg-final',
    content: [{ type: 'text', text: 'Finished.' }],
  },
}));
assert.equal(finalizedTextEvents.length, 1);
assert.equal(finalizedTextEvents[0].type, 'message');
assert.equal(finalizedTextEvents[0].content, 'Finished.');
assert.equal(finalizedTextEvents[0].providerMessageId, 'msg-final');

const uuidOnlyFinalizedTextEvents = createClaudeAdapter().parseLine(JSON.stringify({
  type: 'assistant',
  uuid: 'claude-final-frame-1',
  session_id: 'claude-session-uuid',
  message: {
    content: [{ type: 'text', text: 'UUID is the stable identity.' }],
  },
}));
assert.equal(uuidOnlyFinalizedTextEvents[0].providerEventId, 'claude-final-frame-1');
assert.equal(uuidOnlyFinalizedTextEvents[0].providerSessionId, 'claude-session-uuid');
assert.equal(uuidOnlyFinalizedTextEvents[0].providerReplayFingerprint, undefined);

const fallbackFinalizedTextEvents = createClaudeAdapter().parseLine(JSON.stringify({
  type: 'assistant',
  session_id: 'claude-session-fallback',
  message: {
    content: [{ type: 'text', text: 'Fingerprint only when ids are absent.' }],
  },
}));
assert.equal(fallbackFinalizedTextEvents[0].providerSnapshotKind, 'finalized-assistant');
assert.ok(fallbackFinalizedTextEvents[0].providerReplayFingerprint);
assert.equal(fallbackFinalizedTextEvents[0].providerSessionId, 'claude-session-fallback');

const splitBoundaryAdapter = createClaudeAdapter();
const splitBoundaryMessage = splitBoundaryAdapter.parseLine(JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'Persist immediately.' }] },
}));
assert.equal(splitBoundaryMessage[0].content, 'Persist immediately.');
const emptyResultEvents = createClaudeAdapter().parseLine(JSON.stringify({
  type: 'result',
  subtype: 'success',
}));
assert.deepEqual(emptyResultEvents.map(event => event.type), ['status']);
assert.equal(emptyResultEvents[0].content, 'error: PROVIDER_RESPONSE_INVALID');
assert.equal(emptyResultEvents[0].providerErrorCode, 'PROVIDER_RESPONSE_INVALID');
assert.equal(emptyResultEvents[0].runState, 'failed');
assert.equal(emptyResultEvents[0].providerErrorType, 'provider_response_invalid');

const malformedResultEvents = createClaudeAdapter().parseLine(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'API Error: API returned an empty or malformed response (HTTP 200)',
}));
assert.equal(malformedResultEvents[0].content, 'error: PROVIDER_RESPONSE_INVALID');
assert.equal(malformedResultEvents[0].providerErrorCode, 'PROVIDER_RESPONSE_INVALID');

const apiErrorTerminalEvents = createClaudeAdapter().parseLine(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  terminal_reason: 'api_error',
  result: 'API Error: 402 Insufficient Balance',
}));
assert.equal(apiErrorTerminalEvents[0].content, 'error: API Error: 402 Insufficient Balance');
assert.equal(apiErrorTerminalEvents[0].providerLifecycle, undefined);
assert.equal(apiErrorTerminalEvents[0].runState, 'failed');
assert.equal(apiErrorTerminalEvents[0].providerTerminalReason, 'api_error');

const multiBlockEvents = createClaudeAdapter().parseLine(JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: 'First ' },
      { type: 'text', text: 'part.' },
      { type: 'tool_use', id: 'toolu_multi', name: 'Bash', input: { command: 'pwd' } },
      { type: 'text', text: 'After tool.' },
    ],
  },
}));
assert.deepEqual(multiBlockEvents.map(event => event.type), ['message', 'message', 'tool_use', 'message']);
assert.equal(multiBlockEvents[0].content, 'First ');
assert.equal(multiBlockEvents[1].content, 'part.');
assert.equal(multiBlockEvents[3].content, 'After tool.');
assert.deepEqual(multiBlockEvents.filter(e => e.type === 'message').map(e => e.providerContentBlockIndex), [0, 1, 3]);

const userToolResultEvents = adapter.parseLine(JSON.stringify({
  type: 'user',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: 'ok',
        is_error: false,
      },
    ],
  },
}));
assert.equal(userToolResultEvents.length, 1);
assert.equal(userToolResultEvents[0].type, 'tool_result');
assert.equal(userToolResultEvents[0].providerToolUseId, 'toolu_1');
assert.equal(userToolResultEvents[0].exitCode, 0);
assert.equal(userToolResultEvents[0].operationLifecycle, 'completed');

adapter.parseLine(JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'message_start',
    message: {
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
      },
    },
  },
}));

const streamUsageEvents = adapter.parseLine(JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 7 },
  },
}));
assert.deepEqual(streamUsageEvents, []);

const totalCostEvents = createClaudeAdapter().parseLine(JSON.stringify({
  type: 'result',
  subtype: 'success',
  session_id: 'claude-cost-session',
  total_cost_usd: 0.02,
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 3,
    output_tokens: 7,
  },
}));
const totalCostUsage = totalCostEvents.find(event => event.type === 'usage');
assert.equal(totalCostUsage.contextTokens, 15);
assert.equal(totalCostUsage.outputTokens, 7);
assert.equal(totalCostUsage.costUsd, 0.02);
assert.equal(totalCostUsage.providerSessionId, 'claude-cost-session');

const failedResultEvents = adapter.parseLine(JSON.stringify({
  type: 'result',
  subtype: 'error',
  session_id: 'claude-session-1',
  error: 'unexpected status 401 Unauthorized: Missing bearer token',
  usage: { input_tokens: 1, output_tokens: 0 },
}));
assert.equal(failedResultEvents.at(-1).type, 'status');
assert.equal(failedResultEvents.at(-1).providerErrorType, 'auth_missing');
assert.equal(failedResultEvents.at(-1).providerErrorRetryable, false);

// An Anthropic-compatible relay can reject Claude Code's automatic title
// request after the user-facing run has already terminalized.  That optional
// diagnostic must not overwrite the completed Run in projected history.
const lateTitleAdapter = createClaudeAdapter();
const completedEvents = lateTitleAdapter.parseLine(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: 'User turn completed.',
}));
assert.equal(completedEvents.at(-1).runState, 'completed');
const ignoredLateTitleEvents = lateTitleAdapter.parseLine(JSON.stringify({
  type: 'result', subtype: 'error', is_error: true,
  error: '[claude-code:unrecognized_model] {"model":"glm-5-turbo","query_source":"generate_session_title"} [claude-code:unrecognized_model] {"model":"glm-5.3-flash","query_source":"sdk"}',
}));
assert.deepEqual(ignoredLateTitleEvents, []);

const ordinaryErrorAdapter = createClaudeAdapter();
const ordinarySdkError = ordinaryErrorAdapter.parseLine(JSON.stringify({
  type: 'result', subtype: 'error', is_error: true,
  error: '[claude-code:unrecognized_model] {"model":"glm-5.3-flash","query_source":"sdk"}',
}));
assert.equal(ordinarySdkError.at(-1).runState, 'failed', 'normal SDK errors remain visible');

console.log('test-claude-adapter: ok');
