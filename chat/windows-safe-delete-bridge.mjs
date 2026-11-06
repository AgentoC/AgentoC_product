import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { compileWindowsSafeDelete, planWindowsSafeDelete, compileWindowsSafeDeleteList, planWindowsSafeDeleteList, compileWindowsBashSafeDelete, planWindowsBashSafeDelete } from './windows-safe-delete-plan.mjs';

export async function needsClaudeAbsoluteDeleteRetry({ approval, state, helperPath }, { inspect = lstat } = {}) {
  const params = approval?.params || {};
  if (approval?.providerMethod !== 'can_use_tool' || !['PowerShell', 'Bash'].includes(params.tool_name) || !state?.turnActive || state?.riskContextValid !== true ||
      !['recommended', 'full-auto'].includes(state?.riskMode) || state?.interactionMode === 'plan' || state?.permissionMode === 'plan' ||
      params.networkApprovalContext || params.network_approval_context || params.additionalPermissions || params.additional_permissions ||
      params.input?.cwd || params.input?.workdir || params.input?.working_directory || params.cwd || !path.win32.isAbsolute(helperPath || '')) return false;
  const compiled = params.tool_name === 'Bash' ? compileWindowsBashSafeDelete(params.input?.command) : await compileWindowsSafeDelete(params.input?.command);
  if (!compiled || /^[a-z]:[\\/]/i.test(compiled.target)) return false;
  try { const binary = await inspect(helperPath); return binary?.isFile() === true && !binary.isSymbolicLink(); } catch { return false; }
}

// The helper is non-elevated; its request contains structured data, never
// shell fragments to execute. The sidecar must use its own trusted run state.
export async function buildWindowsSafeDeleteBridge({ approval, state, runId, helperPath }, { plan, inspect = lstat } = {}) {
  const params = approval?.params || {};
  if (approval?.providerMethod !== 'can_use_tool' || !['PowerShell', 'Bash'].includes(params.tool_name) ||
      !state?.turnActive || state?.riskContextValid !== true || !['recommended', 'full-auto'].includes(state?.riskMode) ||
      state?.interactionMode === 'plan' || state?.permissionMode === 'plan' ||
      params.networkApprovalContext || params.network_approval_context || params.additionalPermissions || params.additional_permissions ||
      typeof runId !== 'string' || !runId || typeof approval.approvalId !== 'string' || !approval.approvalId ||
      !path.win32.isAbsolute(helperPath || '')) return null;
  const command = params.input?.command;
  if (typeof command !== 'string') return null;
  const compiled = params.tool_name === 'Bash' ? compileWindowsBashSafeDelete(command)
    : await compileWindowsSafeDelete(command) || await compileWindowsSafeDeleteList(command);
  if (!compiled) return null;
  // Claude's normal PowerShell tool runs in the session directory. Do not
  // infer how an additional working-directory override is interpreted.
  if (params.input?.cwd || params.input?.workdir || params.input?.working_directory || params.cwd) return null;
  let binary;
  try { binary = await inspect(helperPath); } catch { return null; }
  if (!binary?.isFile() || binary.isSymbolicLink()) return null;
  const selected = await (plan || (params.tool_name === 'Bash' ? planWindowsBashSafeDelete : compiled.targets ? planWindowsSafeDeleteList : planWindowsSafeDelete))({ command, state });
  if (!selected) return null;
  const requestKey = `gate:${createHash('sha256').update(JSON.stringify([runId, approval.approvalId])).digest('hex')}`;
  // Relative paths are authorized against the run's trusted cwd, but the
  // provider can execute in a different cwd. The native helper checks its
  // actual cwd before resolving the target and rejects any mismatch.
  const isRelative = !compiled.targets && !/^[a-z]:[\\/]/i.test(compiled.target);
  const request = { schemaVersion: 1, ...selected,
    ...(isRelative ? { relative: '', target: compiled.target, targetFromCwd: true, expectedCwd: path.win32.resolve(state.cwd) } : {}),
    requestKey, originalCommand: command };
  const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64url');
  const quotedHelper = params.tool_name === 'Bash'
    ? `'${helperPath.replace(/\\/g, '/').replace(/'/g, `'"'"'`)}'`
    : `'${helperPath.replace(/'/g, "''")}'`;
  return { updatedCommand: `${params.tool_name === 'PowerShell' ? '& ' : ''}${quotedHelper} --request '${encoded}'`, request };
}
