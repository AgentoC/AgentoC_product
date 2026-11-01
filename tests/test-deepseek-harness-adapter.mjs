#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  buildDeepSeekHarnessArgs,
  createDeepSeekHarnessAdapter,
  DEEPSEEK_HARNESS_RUNTIME_FAMILY,
} from '../chat/adapters/deepseek-harness.mjs';
import { buildRuntimeInvocation } from '../chat/process-runner.mjs';

assert.deepEqual(buildDeepSeekHarnessArgs('整理报表'), ['--profile', 'headless', '整理报表']);
assert.throws(() => buildDeepSeekHarnessArgs('  '), /non-empty prompt/);
const adapter = createDeepSeekHarnessAdapter();
assert.equal(adapter.capabilities.runtimeFamily, DEEPSEEK_HARNESS_RUNTIME_FAMILY);
assert.equal(adapter.parseLine('final answer')[0].content, 'final answer');
assert.deepEqual(adapter.parseLine(''), []);
const invocation = buildRuntimeInvocation(DEEPSEEK_HARNESS_RUNTIME_FAMILY, 'task', {}, 'deepseek-harness');
assert.equal(invocation.args[0], '--profile');
assert.equal(invocation.args[2], 'task');
console.log('DeepSeek Harness adapter tests passed');
