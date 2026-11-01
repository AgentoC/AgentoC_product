#!/usr/bin/env node
import assert from 'node:assert/strict';

import { buildPiArgs, buildPiInput, createPiAdapter, PI_RUNTIME_FAMILY } from '../chat/adapters/pi.mjs';
import { buildRuntimeInvocation } from '../chat/process-runner.mjs';

const adapter = createPiAdapter();
assert.equal(adapter.capabilities.runtimeFamily, PI_RUNTIME_FAMILY);
assert.deepEqual(buildPiArgs({ provider: 'openai', model: 'gpt-5', sessionDir: '/tmp/pi' }), [
  '--mode', 'rpc', '--provider', 'openai', '--model', 'gpt-5', '--session-dir', '/tmp/pi',
]);
assert.match(buildPiInput('你好'), /"type":"prompt"/);
assert.deepEqual(adapter.parseLine(JSON.stringify({ type: 'agent_start' })).map((event) => event.type), ['status']);
assert.deepEqual(adapter.parseLine(JSON.stringify({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
}))[0].type, 'text_delta');
assert.equal(adapter.parseLine(JSON.stringify({ type: 'agent_end' }))[0].runState, 'completed');
assert.deepEqual(adapter.parseLine(JSON.stringify({ type: 'agent_end', willRetry: true,
  messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'rate limited' }] })), [],
  'a Pi retry edge must not publish a completed/failed Run');
assert.equal(adapter.parseLine(JSON.stringify({ type: 'agent_end', willRetry: false,
  messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'exhausted retries' }] }))[0].runState, 'failed');
assert.equal(adapter.parseLine(JSON.stringify({ type: 'agent_end',
  messages: [{ role: 'assistant', stopReason: 'aborted' }] }))[0].runState, 'failed');
assert.deepEqual(adapter.parseLine(JSON.stringify({ type: 'message_end',
  message: { role: 'user', content: 'private input' } })), [], 'user/tool messages must not become assistant replies');
assert.equal(adapter.parseLine(JSON.stringify({ type: 'message_end',
  message: { role: 'assistant', content: [{ type: 'text', text: 'final reply' }] } }))[0].content, 'final reply');

const invocation = buildRuntimeInvocation(PI_RUNTIME_FAMILY, 'prompt', { model: 'gpt-5' }, 'pi');
assert.equal(invocation.isPiFamily, true);
assert.equal(invocation.input.includes('prompt'), true);
assert.equal(invocation.capabilities.provider, 'pi');

console.log('Pi adapter tests passed');
