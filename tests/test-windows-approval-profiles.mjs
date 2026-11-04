import assert from 'node:assert/strict';
import { resolveProviderPermissionPolicy } from '../chat/provider-contract.mjs';
import { buildCodexAppServerThreadOptions, buildCodexAppServerTurnStartMessage } from '../chat/codex-app-server-protocol.mjs';

for (const [runtime, expected] of [
  ['claude-stream-json-bidi', 'default'],
  ['codex-app-server-json', 'untrusted-danger-full-access'],
]) {
  const auto = resolveProviderPermissionPolicy(runtime, { riskMode: 'full-auto', platform: 'win32' });
  const ask = resolveProviderPermissionPolicy(runtime, { riskMode: 'recommended', platform: 'win32' });
  assert.equal(auto.id, expected, `${runtime} autonomous uses the gate`);
  assert.equal(auto.id, ask.id, `${runtime} shares approval gate`);
}
assert.equal(resolveProviderPermissionPolicy('claude-stream-json-bidi', { riskMode: 'conservative-auto', platform: 'win32' }).id, 'auto');
assert.equal(resolveProviderPermissionPolicy('codex-app-server-json', { riskMode: 'conservative-auto', platform: 'win32' }).id, 'on-request-workspace-write');
assert.equal(resolveProviderPermissionPolicy('claude-stream-json-bidi', { riskMode: 'full-auto', platform: 'linux' }).id, 'bypassPermissions');
assert.equal(resolveProviderPermissionPolicy('claude-stream-json', { riskMode: 'full-auto', platform: 'win32' }), null);
const windowsCodexMode = resolveProviderPermissionPolicy('codex-app-server-json', { riskMode: 'recommended', platform: 'win32' }).id;
assert.equal(buildCodexAppServerThreadOptions({ permissionMode: windowsCodexMode }).approvalPolicy, 'untrusted');
assert.equal(buildCodexAppServerTurnStartMessage({ threadId: 'thread', text: 'fixture', permissionMode: windowsCodexMode }).params.approvalPolicy, 'untrusted');
assert.equal(buildCodexAppServerThreadOptions({ permissionMode: windowsCodexMode, agentocApprovalGate: true }).approvalsReviewer, 'user');
assert.equal(buildCodexAppServerThreadOptions({ permissionMode: windowsCodexMode, agentocApprovalGate: true }).config.allow_login_shell, false);
assert.equal(buildCodexAppServerThreadOptions({ permissionMode: windowsCodexMode }).config.allow_login_shell, undefined);
assert.equal(buildCodexAppServerTurnStartMessage({ threadId: 'thread', text: 'fixture', permissionMode: windowsCodexMode, agentocApprovalGate: true }).params.approvalsReviewer, 'user');
assert.equal(buildCodexAppServerThreadOptions({ permissionMode: windowsCodexMode }).approvalsReviewer, undefined);
console.log('windows-approval-profiles: harness mapping checks passed');
