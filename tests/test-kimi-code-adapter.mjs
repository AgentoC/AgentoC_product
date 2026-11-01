#!/usr/bin/env node
import assert from 'node:assert/strict';

import { buildKimiCodeArgs, createKimiCodeAdapter, KIMI_CODE_RUNTIME_FAMILY } from '../chat/adapters/kimi-code.mjs';
import { buildAcpStartInput, buildAcpPromptInput } from '../chat/adapters/acp-stdio.mjs';
import { buildRuntimeInvocation } from '../chat/process-runner.mjs';

assert.deepEqual(buildKimiCodeArgs('分析项目'), ['acp']);
assert.throws(() => buildKimiCodeArgs(''), /non-empty prompt/);
const adapter = createKimiCodeAdapter();
assert.equal(adapter.capabilities.runtimeFamily, KIMI_CODE_RUNTIME_FAMILY);
assert.equal(adapter.parseLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完成' } },
} }))[0].text, '完成');
const invocation = buildRuntimeInvocation(KIMI_CODE_RUNTIME_FAMILY, 'task', {}, 'kimi-code');
assert.deepEqual(invocation.args, ['acp']);
assert.equal(invocation.acp, true);
assert.equal(invocation.permissionMode, null);
assert.equal(buildRuntimeInvocation(KIMI_CODE_RUNTIME_FAMILY, 'task', { riskMode: 'full-auto' }, 'kimi-code').permissionMode, 'yolo');
assert.equal(buildRuntimeInvocation(KIMI_CODE_RUNTIME_FAMILY, 'task', { riskMode: 'conservative-auto' }, 'kimi-code').permissionMode, 'auto');
assert.match(buildAcpStartInput({ cwd: '/tmp' }), /"method":"initialize"/);
assert.match(buildAcpPromptInput('s1', 'task'), /"method":"session\/prompt"/);
console.log('Kimi Code adapter tests passed');
