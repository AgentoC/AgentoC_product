#!/usr/bin/env node
import assert from 'node:assert/strict';

import { buildOpenCodeArgs, createOpenCodeAdapter, OPENCODE_RUNTIME_FAMILY } from '../chat/adapters/opencode.mjs';
import { buildRuntimeInvocation } from '../chat/process-runner.mjs';

assert.deepEqual(buildOpenCodeArgs('修复测试'), ['run', '--format', 'json', '修复测试']);
assert.deepEqual(buildOpenCodeArgs('修复测试', { riskMode: 'full-auto' }), [
  'run', '--format', 'json', '--auto', '修复测试',
]);
assert.throws(() => buildOpenCodeArgs(''), /non-empty prompt/);
const adapter = createOpenCodeAdapter();
assert.equal(adapter.capabilities.runtimeFamily, OPENCODE_RUNTIME_FAMILY);
assert.equal(adapter.parseLine(JSON.stringify({ type: 'text', part: { text: 'done' } }))[0].type, 'text_delta');
assert.equal(adapter.parseLine(JSON.stringify({ type: 'reasoning', part: { text: 'thinking' } }))[0].type, 'reasoning');
assert.equal(adapter.parseLine(JSON.stringify({ type: 'session.error', message: 'bad' }))[0].runState, 'failed');
const invocation = buildRuntimeInvocation(OPENCODE_RUNTIME_FAMILY, 'task', {}, 'opencode');
assert.deepEqual(invocation.args, ['run', '--format', 'json', 'task']);
const autonomousInvocation = buildRuntimeInvocation(OPENCODE_RUNTIME_FAMILY, 'task', { riskMode: 'full-auto' }, 'opencode');
assert.deepEqual(autonomousInvocation.args, ['run', '--format', 'json', '--auto', 'task']);
assert.equal(autonomousInvocation.permissionMode, 'auto');
console.log('OpenCode adapter tests passed');
