import { buildClaudeWindowsInstallBridge, checkWindowsInstallBridgeReadiness } from './windows-auto-install-bridge.mjs';
import { decodeCodexShlexArgv, readWindowsPowerShellInvocation } from './windows-approval-gate.mjs';

// A hook can only suggest a replacement. The control plane must independently
// validate the run binding, eligibility and broker readiness again at submit.
export async function buildCodexWindowsInstallHookDecision({ event, channel, nodePath, scriptPath, preflight = checkWindowsInstallBridgeReadiness } = {}) {
  const noDecision = {};
  if (event?.hook_event_name !== 'PreToolUse' || event?.tool_name !== 'Bash' ||
      typeof event?.tool_use_id !== 'string' || !event.tool_use_id.trim() || event.tool_use_id.length > 1024 ||
      typeof event?.tool_input?.command !== 'string' || !channel?.runId) return noDecision;
  const approval = { approvalId: event.tool_use_id, providerMethod: 'can_use_tool', params: {
    tool_name: 'PowerShell', input: { command: event.tool_input.command },
  } };
  const state = { windowsManagedActionChannel: true, windowsManagedActionBinding: channel, riskMode: 'recommended', riskContextValid: true };
  const bridge = buildClaudeWindowsInstallBridge({ approval, state, runId: channel.runId, nodePath, scriptPath });
  if (!bridge) return noDecision;
  try {
    if (!await preflight({ channel, command: bridge.installCommand, requestKey: bridge.requestKey })) return noDecision;
  } catch { return noDecision; }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: bridge.updatedCommand } } };
}

// Do not trust a hook's output merely because it looks like our bridge. Match
// the complete wrapper and run/item-derived request key, then repeat the
// control-plane preflight before allowing this one provider approval.
export async function verifyCodexWindowsInstallBridgeApproval({ approval, state, runId, nodePath, scriptPath, preflight = checkWindowsInstallBridgeReadiness } = {}) {
  const params = approval?.params || {};
  const channel = state?.windowsManagedActionBinding;
  if (approval?.providerMethod !== 'item/commandExecution/requestApproval' || approval?.kind !== 'command' ||
      state?.windowsManagedActionChannel !== true || state?.startedTurn !== true || state?.riskContextValid === false ||
      !['recommended', 'full-auto'].includes(state?.riskMode) || !runId || channel?.runId !== runId ||
      !state?.threadId || params.threadId !== state.threadId || !state?.turnId || params.turnId !== state.turnId ||
      typeof params.itemId !== 'string' || !params.itemId.trim() || params.itemId.length > 1024 ||
      params.networkApprovalContext || params.network_approval_context || params.additionalPermissions || params.additional_permissions) return false;
  const argv = decodeCodexShlexArgv(params.command);
  const invocation = readWindowsPowerShellInvocation({ params: { command: argv } });
  let command = invocation?.command || '';
  const utf8Prefix = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n';
  if (command.startsWith(utf8Prefix)) command = command.slice(utf8Prefix.length);
  const encoded = /'([A-Za-z0-9_-]+)'$/.exec(command)?.[1];
  if (!encoded || encoded.length > 32 * 1024) return false;
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return false; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || !['command,requestKey', 'command,requestKey,windowsUserInstallIdentity'].includes(Object.keys(payload).sort().join(','))) return false;
  const expected = buildClaudeWindowsInstallBridge({ approval: { approvalId: params.itemId, providerMethod: 'can_use_tool', params: {
    tool_name: 'PowerShell', input: { command: payload.command },
  } }, state, runId, nodePath, scriptPath });
  if (!expected || expected.updatedCommand !== command || expected.requestKey !== payload.requestKey) return false;
  try { return await preflight({ channel, command: payload.command, requestKey: payload.requestKey }) === true; } catch { return false; }
}
