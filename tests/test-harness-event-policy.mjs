#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  getHarnessEventPolicy,
  isHarnessEphemeralEvent,
  limitHarnessDurableEvents,
  prepareHarnessEventForPersistence,
} from '../chat/harness-event-policy.mjs';
import { getProviderEventReplayKey } from '../chat/provider-event-dedup.mjs';

const runtimeFamilies = [
  'claude-stream-json', 'claude-stream-json-bidi', 'codex-json',
  'codex-app-server-json', 'copilot-json', 'hermes-acp', 'agy-json',
  'agy-stream-json', 'pi-rpc-jsonl', 'deepseek-harness-acp', 'qwen-code-acp',
  'opencode-json', 'kimi-code-acp', 'goose-headless', 'openhands-headless',
  'openhands-agent-server', 'cline-json', 'kilo-json',
];

for (const runtimeFamily of runtimeFamilies) {
  const policy = getHarnessEventPolicy(runtimeFamily);
  assert.equal(policy.runtimeFamily, runtimeFamily);
  assert.equal(policy.version, '1');
  assert.ok(policy.maxPersistedToolOutputBytes > 0);
}

assert.equal(isHarnessEphemeralEvent({ type: 'text_delta' }), true);
assert.equal(isHarnessEphemeralEvent({ type: 'reasoning' }), true);
assert.equal(isHarnessEphemeralEvent({
  type: 'tool_result', runId: 'run-1', runtimeFamily: 'codex-app-server-json',
  operationLifecycle: 'delta', providerItemId: 'call-1', output: 'partial',
}), true);
assert.equal(isHarnessEphemeralEvent({
  type: 'tool_result', runId: 'run-1', runtimeFamily: 'codex-app-server-json',
  operationLifecycle: 'completed', providerItemId: 'call-1', output: 'final',
}), false);
assert.equal(isHarnessEphemeralEvent({
  type: 'status', runId: 'run-1', runtimeFamily: 'opencode-json', content: 'Step started',
}), true);
assert.equal(isHarnessEphemeralEvent({
  type: 'status', runId: 'run-1', runtimeFamily: 'opencode-json', runState: 'completed', content: 'completed',
}), false);
assert.equal(isHarnessEphemeralEvent({ type: 'status', content: 'internal status' }), false);

const longOutput = 'x'.repeat(100_000);
const prepared = prepareHarnessEventForPersistence({
  type: 'tool_result', runId: 'run-1', runtimeFamily: 'opencode-json', output: longOutput,
});
assert.ok(prepared.output.length < longOutput.length);
assert.equal(prepared.outputTruncated, true);
assert.equal(prepared.outputBytes, longOutput.length);

const statusA = { type: 'status', runId: 'run-1', runtimeFamily: 'opencode-json', content: 'Step started' };
const statusB = { type: 'status', runId: 'run-1', runtimeFamily: 'opencode-json', content: 'Step completed', runState: 'completed' };
const keyA = getProviderEventReplayKey(statusA);
const keyB = getProviderEventReplayKey(statusB);
assert.ok(keyA);
assert.notEqual(keyA, keyB);

const bounded = limitHarnessDurableEvents([
  ...Array.from({ length: 800 }, (_, index) => ({
    type: 'tool_use', runId: 'run-1', runtimeFamily: 'opencode-json',
    providerToolUseId: `tool-${index}`,
    toolName: 'shell', toolInput: 'echo ok',
  })),
  { type: 'message', runId: 'run-1', runtimeFamily: 'opencode-json', content: 'final' },
]);
assert.ok(bounded.length <= 513, 'repeated progress must obey the per-tick cap');
assert.equal(bounded.at(-1).type, 'message');

console.log('harness-event-policy: ok');
