#!/usr/bin/env node
import assert from 'assert/strict';
import { buildCodexArgs, createCodexAdapter } from '../chat/adapters/codex.mjs';
import { buildCopilotArgs, createCopilotAdapter } from '../chat/adapters/copilot.mjs';
import {
  isClaudeLifecycleStatusEvent,
  isCodexAppServerLifecycleStatusEvent,
  isCodexAppServerLifecycleStatusMessage,
  isProviderUsageLimitMessage,
  isProviderUsageLimitStatusEvent,
  isTransientProviderReconnectErrorPayload,
  isTransientProviderReconnectMessage,
  isTransientProviderReconnectStatusEvent,
} from '../chat/provider-runtime-noise.mjs';

assert.equal(
  isClaudeLifecycleStatusEvent({
    type: 'status',
    content: 'System: thinking_tokens',
    provider: 'claude',
  }),
  true,
  'Claude thinking token telemetry should be classified as display noise',
);
assert.equal(
  isClaudeLifecycleStatusEvent({
    type: 'status',
    content: 'stop: end_turn',
    runtimeFamily: 'claude-stream-json',
  }),
  true,
  'normal Claude stop reasons should be classified as lifecycle noise',
);
assert.equal(
  isClaudeLifecycleStatusEvent({
    type: 'status',
    content: 'retrying: overloaded',
    provider: 'claude',
  }),
  false,
  'actionable Claude retry diagnostics should remain visible',
);

const timeoutMessage = 'Reconnecting... 2/5 (timeout waiting for child process to exit)';
const timeoutStatus = `error: ${timeoutMessage}`;
const authMessage = 'Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer token)';

assert.equal(
  isTransientProviderReconnectMessage(timeoutMessage),
  true,
  'bare provider reconnect timeout messages should be recognized as transient noise',
);
assert.equal(
  isTransientProviderReconnectMessage(timeoutStatus),
  true,
  'stored status-form provider reconnect timeout messages should be recognized as transient noise',
);
assert.equal(
  isTransientProviderReconnectMessage('error: Reconnecting… 5/5 (timeout waiting for child process to exit)'),
  true,
  'unicode ellipsis reconnect timeout messages should also be recognized',
);
assert.equal(
  isTransientProviderReconnectMessage(authMessage),
  false,
  'authentication reconnect errors should remain visible',
);
assert.equal(
  isTransientProviderReconnectStatusEvent({ type: 'status', content: timeoutStatus }),
  true,
  'stored status events for transient reconnect timeouts should be suppressible from display',
);
assert.equal(
  isTransientProviderReconnectErrorPayload({ type: 'error', message: timeoutMessage }),
  true,
  'provider JSON error payloads for transient reconnect timeouts should be suppressible before storage',
);
assert.equal(
  isProviderUsageLimitMessage('Usage GPT-5.3-Codex-Spark · primary 0% / 300m · secondary 0% / 10080m · no credits'),
  true,
  'provider rate-limit usage summaries should be recognized as display noise',
);
assert.equal(
  isProviderUsageLimitStatusEvent({
    type: 'status',
    content: 'Usage GPT-5.3-Codex-Spark · primary 0% / 300m',
    codexRateLimits: { limitName: 'GPT-5.3-Codex-Spark' },
  }),
  true,
  'stored Codex app-server rate-limit status events should be suppressible from display',
);
assert.equal(
  isProviderUsageLimitMessage('Usage docs should cite primary sources'),
  false,
  'ordinary usage wording should remain visible',
);
assert.equal(
  isCodexAppServerLifecycleStatusMessage('MCP starting'),
  true,
  'Codex app-server MCP lifecycle text should be recognized as display noise',
);
assert.equal(
  isCodexAppServerLifecycleStatusEvent({
    type: 'status',
    content: 'MCP starting',
    runtimeFamily: 'codex-app-server-json',
  }),
  true,
  'Codex app-server MCP startup status events should be suppressible from display',
);
assert.equal(
  isCodexAppServerLifecycleStatusEvent({
    type: 'status',
    content: 'MCP ready',
    codexMcpStatus: 'ready',
  }),
  true,
  'Codex app-server MCP ready status events should be suppressible from display',
);
assert.equal(
  isCodexAppServerLifecycleStatusEvent({
    type: 'status',
    content: 'Thread ready (019ef911-42e4-79e2-a8bd-b936c7393343)',
    providerThreadId: '019ef911-42e4-79e2-a8bd-b936c7393343',
  }),
  true,
  'Codex app-server thread readiness status events should be suppressible from display',
);
assert.equal(
  isCodexAppServerLifecycleStatusEvent({
    type: 'status',
    content: 'Goal cleared',
    codexGoalEvent: 'cleared',
  }),
  true,
  'Codex app-server goal status events should be suppressible from display',
);
assert.equal(
  isCodexAppServerLifecycleStatusEvent({
    type: 'status',
    content: 'inProgress',
    runtimeFamily: 'codex-app-server-json',
  }),
  true,
  'Codex app-server turn progress status events should be suppressible from display',
);
assert.equal(
  isCodexAppServerLifecycleStatusEvent({
    type: 'status',
    content: 'mode: default',
    provider: 'codex',
  }),
  true,
  'Codex app-server mode status events should be suppressible from display',
);
assert.equal(
  isCodexAppServerLifecycleStatusEvent({
    type: 'status',
    content: 'Preparing environment',
    runtimeFamily: 'codex-app-server-json',
  }),
  false,
  'ordinary useful provider statuses should remain visible',
);

for (const [name, adapter] of [
  ['Codex', createCodexAdapter()],
  ['Copilot', createCopilotAdapter()],
]) {
  assert.deepEqual(
    adapter.parseLine(JSON.stringify({ type: 'error', message: timeoutMessage })),
    [],
    `${name} adapter should not emit status events for transient reconnect timeouts`,
  );
  assert.equal(
    adapter.parseLine(JSON.stringify({ type: 'error', message: authMessage })).at(0)?.content,
    `error: ${authMessage}`,
    `${name} adapter should preserve non-timeout reconnect errors`,
  );
}

assert.ok(
  buildCodexArgs('Say ok.', {}).includes('--disable')
    && buildCodexArgs('Say ok.', {}).includes('unified_exec'),
  'Codex launcher args should disable unified_exec using the current feature flag syntax',
);
const copilotArgs = buildCopilotArgs('Say ok.', {});
assert.ok(copilotArgs.includes('--output-format') && copilotArgs.includes('json'));
assert.ok(copilotArgs.includes('--allow-all-tools'));
assert.ok(copilotArgs.includes('--no-ask-user'));
const copilotPromptIndex = copilotArgs.indexOf('--prompt');
assert.ok(copilotPromptIndex >= 0 && copilotArgs[copilotPromptIndex + 1].includes('Say ok.'));
assert.equal(copilotArgs.includes('--disable'), false);
assert.equal(copilotArgs.includes('unified_exec'), false);
assert.equal(copilotArgs.includes('--dangerously-bypass-approvals-and-sandbox'), false);

console.log('test-provider-runtime-noise: ok');
