import path from 'node:path';
import { parseWindowsPowerShellAst } from './windows-powershell-ast.mjs';
import { parseLiteralBashWords } from './windows-bash-actions.mjs';

const elevationPrograms = new Set(['runas', 'runas.exe', 'gsudo', 'gsudo.exe', 'sudo', 'sudo.exe']);
const nameOf = value => path.win32.basename(String(value || '').replaceAll('/', '\\')).toLowerCase();

// This is guidance for explicit elevation, not a privilege or risk classifier.
// Unrecognized and dynamic commands remain with the existing approval policy.
export async function needsWindowsElevationGuidance(command, shell = 'PowerShell', parse = parseWindowsPowerShellAst) {
  if (typeof command !== 'string' || !/runas|gsudo|sudo/i.test(command)) return false;
  if (shell === 'Bash') {
    const words = parseLiteralBashWords(command);
    return !!words && words.length > 1 && elevationPrograms.has(nameOf(words[0])) && !/^--?(help|version)$/i.test(words[1]);
  }
  let ast;
  try { ast = await parse(command); } catch { return false; }
  if (ast.errors?.length || !Array.isArray(ast.commands)) return false;
  return ast.commands.some(item => {
    const name = nameOf(item.name);
    const elements = item.elements || [];
    if (elevationPrograms.has(name)) {
      const arg = elements[1];
      return !!arg && !(arg.kind === 'literal' && /^--?(help|version)$/i.test(arg.value));
    }
    if (!['start-process', 'start', 'saps'].includes(name)) return false;
    return elements.some((element, index) => element.kind === 'parameter' && /^verb$/i.test(element.name) &&
      ((element.argumentType === 'StringConstantExpressionAst' && /^runas$/i.test(String(element.value))) ||
       (element.argumentType == null && elements[index + 1]?.kind === 'literal' && /^runas$/i.test(elements[index + 1].value))));
  });
}

export function windowsElevationGuidance(channelAvailable) {
  return channelAvailable
    ? 'Use AgentoC’s separate managed privileged executor through the agentoc_request_actions tool for the underlying concrete command. Do not use direct elevation wrappers. The current approval policy still applies; if the operation is unsupported, report that limitation.'
    : 'AgentoC’s managed privileged action channel is unavailable. Do not use direct elevation wrappers; report that the operation is blocked.';
}

export async function buildCodexWindowsElevationGuidance({ event, channel } = {}) {
  if (event?.hook_event_name !== 'PreToolUse' || event?.tool_name !== 'Bash' ||
      typeof event.tool_use_id !== 'string' || !event.tool_use_id.trim() || event.tool_use_id.length > 1024 ||
      !await needsWindowsElevationGuidance(event.tool_input?.command)) return {};
  const available = !!(channel?.endpoint && channel?.token && channel?.sessionId && channel?.runId && channel?.turnId);
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: windowsElevationGuidance(available) } };
}
