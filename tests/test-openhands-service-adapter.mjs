#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  OpenHandsServiceClient,
  buildOpenHandsAgent,
  buildOpenHandsCreateConversationPayload,
  buildOpenHandsEventsWebSocketUrl,
  buildOpenHandsUserEvent,
  bridgeOpenHandsServiceEvent,
  normalizeOpenHandsExecutionStatus,
} from '../chat/adapters/openhands-service.mjs';

assert.deepEqual(buildOpenHandsAgent({ model: 'gpt-test', apiKey: 'secret', baseUrl: 'https://llm.test/v1' }), {
  kind: 'Agent',
  llm: { model: 'gpt-test', api_key: 'secret', base_url: 'https://llm.test/v1' },
});
assert.deepEqual(buildOpenHandsCreateConversationPayload({
  agent: { kind: 'Agent', llm: { model: 'gpt-test' } },
  workingDir: '/tmp/work',
  initialMessage: 'Fix it',
}), {
  agent: { kind: 'Agent', llm: { model: 'gpt-test' } },
  max_iterations: 500,
  stuck_detection: true,
  workspace: { kind: 'LocalWorkspace', working_dir: '/tmp/work' },
  user_id: null,
  initial_message: { role: 'user', content: [{ type: 'text', text: 'Fix it' }] },
});
assert.deepEqual(buildOpenHandsUserEvent('continue'), {
  role: 'user', content: [{ type: 'text', text: 'continue' }], run: false,
});
assert.equal(buildOpenHandsEventsWebSocketUrl('https://oh.test/base/', 'a/b', 'key'), 'wss://oh.test/base/sockets/events/a%2Fb?session_api_key=key');
assert.equal(normalizeOpenHandsExecutionStatus('finished'), 'completed');
assert.equal(normalizeOpenHandsExecutionStatus('waiting_for_confirmation'), 'waiting');
assert.deepEqual(bridgeOpenHandsServiceEvent({
  kind: 'StreamingDeltaEvent', id: 'e1', content: 'hello', reasoning_content: 'think',
}), [
  { type: 'assistant.delta', content: 'hello', id: 'e1' },
  { type: 'reasoning.delta', content: 'think', id: 'e1' },
]);
assert.deepEqual(bridgeOpenHandsServiceEvent({
  kind: 'ActionEvent', id: 'e2', tool_name: 'execute_bash', tool_call_id: 'call-1',
  action: { kind: 'ExecuteBashAction', command: 'echo ok' },
}), [{
  type: 'tool.started', toolName: 'execute_bash', input: { kind: 'ExecuteBashAction', command: 'echo ok' },
  toolCallId: 'call-1', id: 'e2',
}]);
assert.deepEqual(bridgeOpenHandsServiceEvent({ kind: 'ConversationStateUpdateEvent', key: 'execution_status', value: 'finished' }), [{ type: 'run.completed' }]);
assert.throws(() => buildOpenHandsUserEvent(' '), /message is required/);

const calls = [];
const client = new OpenHandsServiceClient({
  host: 'https://oh.test',
  apiKey: 'key',
  fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, text: async () => '{"id":"conv-1"}' };
  },
});
assert.deepEqual(await client.createConversation({ agent: { kind: 'Agent' } }), { id: 'conv-1' });
await client.runConversation('conv-1');
await client.respondToConfirmation('conv-1', { accept: true, reason: 'ok' });
assert.equal(calls[0].options.headers['X-Session-API-Key'], 'key');
assert.equal(calls[1].url, 'https://oh.test/api/conversations/conv-1/run');
assert.equal(calls[2].url, 'https://oh.test/api/conversations/conv-1/events/respond_to_confirmation');
assert.deepEqual(JSON.parse(calls[2].options.body), { accept: true, reason: 'ok' });

const timeoutClient = new OpenHandsServiceClient({
  host: 'https://oh.test',
  requestTimeoutMs: 10,
  fetchImpl: (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }),
});
await assert.rejects(
  timeoutClient.runConversation('conv-timeout'),
  (error) => error?.code === 'OPENHANDS_REQUEST_TIMEOUT',
);
console.log('OpenHands service adapter tests passed');
