#!/usr/bin/env node
import assert from 'node:assert/strict';

import { buildQwenCodeArgs, createQwenCodeAdapter, QWEN_CODE_RUNTIME_FAMILY } from '../chat/adapters/qwen-code.mjs';
import { buildRuntimeInvocation } from '../chat/process-runner.mjs';

assert.deepEqual(buildQwenCodeArgs('生成周报'), ['--acp']);
assert.deepEqual(buildQwenCodeArgs('生成周报', { riskMode: 'full-auto' }), [
  '--acp', '--approval-mode', 'yolo',
]);
assert.deepEqual(buildQwenCodeArgs('生成周报', { riskMode: 'conservative-auto' }), [
  '--acp', '--approval-mode', 'auto',
]);
assert.throws(() => buildQwenCodeArgs(''), /non-empty prompt/);
const adapter = createQwenCodeAdapter();
assert.equal(adapter.capabilities.runtimeFamily, QWEN_CODE_RUNTIME_FAMILY);
assert.equal(adapter.parseLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完成' } },
} }))[0].text, '完成');
const invocation = buildRuntimeInvocation(QWEN_CODE_RUNTIME_FAMILY, 'task', {}, 'qwen-code');
assert.deepEqual(invocation.args, ['--acp']);
assert.equal(invocation.acp, true);
const autonomousInvocation = buildRuntimeInvocation(QWEN_CODE_RUNTIME_FAMILY, 'task', {
  riskMode: 'full-auto',
}, 'qwen-code');
assert.equal(autonomousInvocation.permissionMode, 'yolo');
assert.deepEqual(autonomousInvocation.args, ['--acp', '--approval-mode', 'yolo']);
const guardedInvocation = buildRuntimeInvocation(QWEN_CODE_RUNTIME_FAMILY, 'task', {
  riskMode: 'conservative-auto',
}, 'qwen-code');
assert.equal(guardedInvocation.permissionMode, 'auto');
assert.deepEqual(guardedInvocation.args, ['--acp', '--approval-mode', 'auto']);
console.log('Qwen Code adapter tests passed');
