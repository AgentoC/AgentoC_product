import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { parseWindowsPowerShellAst } from './windows-powershell-ast.mjs';

// Only replace a complete, literal read operation. Never forward the original
// shell text or arbitrary CLI options to the native launcher.
export async function buildWindowsCliReadBridge({ approval, state, helperPath, port, runId }, { parse = parseWindowsPowerShellAst, inspect = lstat } = {}) {
  const params = approval?.params || {};
  if (approval?.providerMethod !== 'can_use_tool' || params.tool_name !== 'PowerShell' ||
      !state?.turnActive || state.riskContextValid !== true || state.sessionControlReadAvailable !== true ||
      !state.windowsManagedActionChannel || !runId || state.windowsManagedActionBinding?.runId !== runId || !['recommended', 'full-auto'].includes(state.riskMode) ||
      state.interactionMode === 'plan' || state.permissionMode === 'plan' ||
      params.networkApprovalContext || params.network_approval_context || params.additionalPermissions || params.additional_permissions ||
      params.input?.cwd || params.input?.workdir || params.input?.working_directory || params.cwd ||
      !path.win32.isAbsolute(helperPath || '') || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const command = params.input?.command;
  if (typeof command !== 'string' || command.length > 8192) return null;
  let ast, binary;
  try { [ast, binary] = await Promise.all([parse(command), inspect(helperPath)]); } catch { return null; }
  if (!binary?.isFile() || binary.isSymbolicLink() || ast.errors.length || ast.dynamicNodes.length ||
      ast.expressions?.length || ![1, 2].includes(ast.commands.length)) return null;
  const first = ast.commands[0];
  const words = first.elements.map(element => element.kind === 'literal' ? String(element.value).toLowerCase() : null);
  if (!['unknown', 'ampersand'].includes(String(first.invocation).toLowerCase()) || first.pipelineInput ||
      !['agentoc', 'agentoc.cmd'].includes(words[0]) || words[1] !== 'trigger' || words[2] !== 'list' ||
      ![3, 4].includes(words.length) || (words.length === 4 && words[3] !== '--json') ||
      first.redirections > 1 || first.redirectFacts?.length !== first.redirections ||
      first.redirectFacts.some(redirect => redirect.type !== 'MergingRedirectionAst')) return null;
  if (ast.commands.length === 2) {
    const second = ast.commands[1];
    if (String(second.name).toLowerCase() !== 'out-string' || !second.pipelineInput || second.redirections ||
        second.elements.length !== 1 || second.elements[0].kind !== 'literal' ||
        String(second.elements[0].value).toLowerCase() !== 'out-string') return null;
  }
  const quoted = `'${helperPath.replace(/'/g, "''")}'`;
  return { updatedCommand: `& ${quoted} trigger-list 'http://127.0.0.1:${port}'${words.length === 4 ? ' --json' : ''}` };
}
