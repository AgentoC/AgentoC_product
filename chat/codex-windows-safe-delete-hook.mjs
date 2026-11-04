import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { buildWindowsSafeDeleteBridge } from './windows-safe-delete-bridge.mjs';
import { compileWindowsSafeDelete } from './windows-safe-delete-plan.mjs';
import { decodeCodexShlexArgv, readWindowsPowerShellInvocation } from './windows-approval-gate.mjs';

// A hook does not receive exec_command's working-directory override. Ask the
// model to retry a relative target as an absolute path before rewriting; an
// unsafe absolute target then follows the provider's normal approval path.
export async function buildCodexWindowsSafeDeleteHookDecision({ event, state, runId, helperPath } = {}) {
  if (event?.hook_event_name !== 'PreToolUse' || event?.tool_name !== 'Bash' || typeof event.tool_use_id !== 'string' ||
      !event.tool_use_id || event.tool_use_id.length > 1024 || typeof event.tool_input?.command !== 'string' ||
      !/^[a-z]:[\\/]/i.test(event.cwd || '')) return {};
  const compiled = await compileWindowsSafeDelete(event.tool_input.command);
  if (!compiled || state?.riskContextValid !== true || !['recommended', 'full-auto'].includes(state?.riskMode) ||
      state?.interactionMode === 'plan' || state?.permissionMode === 'plan' || !runId ||
      !/^[a-z]:[\\/]/i.test(state?.riskContext?.trustedWorkspaceRoot || '') || !path.win32.isAbsolute(helperPath || '')) return {};
  let binary;
  try { binary = await lstat(helperPath); } catch { return {}; }
  if (!binary.isFile() || binary.isSymbolicLink()) return {};
  if (!/^[a-z]:[\\/]/i.test(compiled.target)) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: 'For this Windows deletion, resolve the target against the command working directory and retry the same command using an absolute path and the same options.' } };
  const approval = { approvalId: event.tool_use_id, providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command: event.tool_input.command } } };
  const bridge = await buildWindowsSafeDeleteBridge({ approval, state: { ...state, cwd: event.cwd, turnActive: true }, runId, helperPath });
  return bridge ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: bridge.updatedCommand } } } : {};
}

// The approval request contains Codex's actual per-command cwd. Recompile
// the original command against that cwd and compare the entire replacement.
export async function verifyCodexWindowsSafeDeleteApproval({ approval, state, runId, helperPath } = {}) {
  const params = approval?.params || {};
  if (approval?.providerMethod !== 'item/commandExecution/requestApproval' || approval?.kind !== 'command' ||
      state?.startedTurn !== true || state?.riskContextValid !== true || !['recommended', 'full-auto'].includes(state?.riskMode) ||
      state?.interactionMode === 'plan' || state?.permissionMode === 'plan' || !state?.threadId || params.threadId !== state.threadId ||
      !state?.turnId || params.turnId !== state.turnId || !/^[a-z]:[\\/]/i.test(params.cwd || '') ||
      typeof params.itemId !== 'string' || !params.itemId || params.itemId.length > 1024 ||
      params.networkApprovalContext || params.network_approval_context || params.additionalPermissions || params.additional_permissions) return false;
  const invocation = readWindowsPowerShellInvocation({ params: { command: decodeCodexShlexArgv(params.command) } });
  let command = invocation?.command || '';
  const prefix = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n';
  if (command.startsWith(prefix)) command = command.slice(prefix.length);
  const encoded = /--request '([A-Za-z0-9_-]+)'$/.exec(command)?.[1];
  if (!encoded || encoded.length > 32768) return false;
  let request;
  try { request = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return false; }
  const compiled = await compileWindowsSafeDelete(request?.originalCommand);
  if (!compiled || !path.win32.isAbsolute(compiled.target)) return false;
  const source = { approvalId: params.itemId, providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command: request.originalCommand } } };
  const expected = await buildWindowsSafeDeleteBridge({ approval: source, state: { ...state, cwd: params.cwd, turnActive: true }, runId, helperPath });
  return Boolean(expected && expected.updatedCommand === command);
}
