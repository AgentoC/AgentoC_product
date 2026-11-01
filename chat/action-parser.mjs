import { redactSensitiveText } from './tool-call-schema.mjs';
import { parsePlatformShellCommand, inferShellKind } from './action-parser-platform.mjs';

const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'sed', 'awk', 'less', 'more', 'bat', 'git-show']);
const LIST_COMMANDS = new Set(['ls', 'dir', 'tree', 'exa', 'eza']);
const SEARCH_COMMANDS = new Set(['rg', 'ripgrep', 'grep', 'egrep', 'fgrep', 'find', 'git-grep']);
const INSPECT_COMMANDS = new Set(['pwd', 'whoami', 'git-status', 'git-diff', 'git-log', 'git-branch']);
const WRAPPERS = new Set(['env', 'command', 'xargs']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clip(value, max = 160) {
  const safe = redactSensitiveText(text(value)).replace(/\s+/g, ' ');
  if (safe.length <= max) return safe;
  return `${safe.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function shellTokens(command) {
  const tokens = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const char of String(command || '')) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function commandName(tokens) {
  let index = 0;
  while (index < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index]) || tokens[index].startsWith('-'))) index += 1;
  while (index < tokens.length && WRAPPERS.has(tokens[index])) {
    index += 1;
    while (index < tokens.length && tokens[index].startsWith('-')) index += 1;
  }
  const executable = text(tokens[index]).replace(/\\/g, '/').split('/').pop().toLowerCase();
  return { executable, index };
}

function targetPath(args) {
  return args.filter((arg) => arg && !arg.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(arg)).pop() || '';
}

function parseSingle(command, cwd = '') {
  const rawCommand = clip(command, 320);
  const tokens = shellTokens(command);
  const { executable, index } = commandName(tokens);
  if (!executable) return { semanticKind: 'execute', subject: '', detail: rawCommand, groupable: false, confidence: 'low', rawCommand };
  const args = tokens.slice(index + 1);
  const gitSubcommand = executable === 'git' ? args.find((arg) => arg && !arg.startsWith('-')) : '';
  const normalized = executable === 'git' && gitSubcommand
    ? `git-${String(gitSubcommand).toLowerCase()}`
    : executable;
  if (normalized === 'bash' || normalized === 'sh' || normalized === 'zsh') {
    const nested = args.find((arg, i) => ['-c', '-lc', '-ic'].includes(arg) && args[i + 1]);
    if (nested) return parseSingle(args[args.indexOf(nested) + 1], cwd);
  }
  if (READ_COMMANDS.has(normalized)) {
    const path = targetPath(args) || cwd;
    return { semanticKind: 'read', subject: clip(path.replace(/\\/g, '/').split('/').pop() || path, 80), detail: clip(path), groupable: true, confidence: 'high', rawCommand };
  }
  if (LIST_COMMANDS.has(normalized)) {
    const path = targetPath(args) || cwd || '.';
    return { semanticKind: 'list', subject: clip(path, 80), detail: clip(path), groupable: true, confidence: 'high', rawCommand };
  }
  if (SEARCH_COMMANDS.has(normalized)) {
    const values = args.filter((arg) => arg && !arg.startsWith('-'));
    const query = values[0] || '';
    const path = values[1] || cwd || '';
    return { semanticKind: 'search', subject: clip([query, path].filter(Boolean).join(' in '), 80), detail: clip([query, path].filter(Boolean).join(' · ')), groupable: true, confidence: 'high', rawCommand };
  }
  if (INSPECT_COMMANDS.has(normalized)) {
    const subject = normalized === 'git-status' ? 'workspace status'
      : normalized === 'git-diff' ? 'workspace changes'
        : normalized === 'git-log' ? 'commit history'
          : normalized === 'git-branch' ? 'branches' : normalized;
    return { semanticKind: 'inspect', subject: clip(subject, 80), detail: rawCommand, groupable: true, confidence: 'medium', rawCommand };
  }
  // For opaque commands the executable alone is not enough to explain the
  // action (for example, `npm` could run tests, install packages, or start a
  // dev server). Keep the bounded command line as the subject so the activity
  // strip and replay projection retain the same useful intent as the raw
  // provider event.
  return { semanticKind: 'execute', subject: clip(rawCommand, 80), detail: rawCommand, groupable: false, confidence: 'low', rawCommand };
}

export function parseShellCommand(command, options = {}) {
  const raw = text(command);
  if (!raw) return null;
  const shellKind = inferShellKind({ ...options, command: raw });
  const platformAction = parsePlatformShellCommand(raw, { ...options, shellKind });
  if (platformAction) return platformAction;
  // Composite commands are intentionally not grouped. Their raw command is
  // retained for audit and the UI uses the generic execute label.
  if (/(?:&&|\|\||(?<!\\);|(?<!\\)\|)/.test(raw)) {
    return { semanticKind: 'execute', subject: 'multiple commands', detail: clip(raw, 320), groupable: false, confidence: 'low', rawCommand: clip(raw, 320), composite: true };
  }
  return parseSingle(raw, text(options.cwd));
}

export function parseStructuredCommandActions(actions, options = {}) {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  const first = actions[0] && typeof actions[0] === 'object' ? actions[0] : {};
  const kind = text(first.type || first.action || first.kind).toLowerCase();
  const path = text(first.path || first.filePath || first.file_path || first.target);
  const query = text(first.query || first.pattern || first.needle);
  if (kind.includes('search')) return { semanticKind: 'search', subject: clip([query, path].filter(Boolean).join(' in '), 80), detail: clip([query, path].filter(Boolean).join(' · ')), groupable: true, confidence: 'high' };
  if (kind.includes('list') || kind.includes('directory')) return { semanticKind: 'list', subject: clip(path || text(options.cwd) || '.', 80), detail: clip(path || text(options.cwd)), groupable: true, confidence: 'high' };
  if (kind.includes('read') || kind.includes('file')) return { semanticKind: 'read', subject: clip(path.replace(/\\/g, '/').split('/').pop() || path, 80), detail: clip(path), groupable: true, confidence: 'high' };
  return null;
}

export function parseProviderAction(event = {}) {
  const platform = event.executionPlatform || event.platform || process.platform;
  const shellKind = inferShellKind({
    executionPlatform: platform,
    shellKind: event.shellKind || event.shell,
    shellPath: event.shellPath,
    command: event.command,
  });
  const attachEnvironment = (parsed) => {
    if (!parsed) return null;
    Object.defineProperty(parsed, 'executionPlatform', { value: String(platform), enumerable: false, configurable: true });
    Object.defineProperty(parsed, 'shellKind', { value: shellKind, enumerable: false, configurable: true });
    return parsed;
  };
  const structured = parseStructuredCommandActions(event.providerActions, { cwd: event.cwd });
  if (structured) return attachEnvironment(structured);
  const command = text(event.command) || text(event.input?.command) || text(event.toolInput?.command);
  if (command) return attachEnvironment(parseShellCommand(command, {
    cwd: event.cwd,
    executionPlatform: platform,
    shellKind: event.shellKind || event.shell,
    shellPath: event.shellPath,
  }));
  const explicitSemanticKind = text(event.operationSemanticKind || event.semanticKind).toLowerCase();
  if (explicitSemanticKind) {
    const explicitSubject = text(event.operationSubject || event.subject || event.detail);
    const explicitDetail = text(event.operationDetail || event.detail || explicitSubject);
    return attachEnvironment({
      semanticKind: explicitSemanticKind,
      subject: clip(explicitSubject, 80),
      detail: clip(explicitDetail, 320),
      groupable: ['read', 'list', 'search', 'inspect'].includes(explicitSemanticKind),
      confidence: explicitSubject ? 'high' : 'medium',
    });
  }
  const kind = text(event.operationKind || event.kind).toLowerCase();
  const input = event.input && typeof event.input === 'object' ? event.input : {};
  const path = text(input.path || input.file_path || event.filePath || event.detail);
  const query = text(input.query || input.pattern || event.detail);
  if (kind === 'read' || kind === 'file_edit') return attachEnvironment({ semanticKind: kind === 'file_edit' ? 'edit' : 'read', subject: clip(path.replace(/\\/g, '/').split('/').pop() || path, 80), detail: clip(path), groupable: false, confidence: 'high' });
  if (kind === 'search') return attachEnvironment({ semanticKind: 'search', subject: clip(query, 80), detail: clip(query), groupable: true, confidence: 'high' });
  if (kind === 'mcp') {
    const toolName = text(input.toolName || input.tool_name || input.name || event.toolName || event.sourceToolName);
    return attachEnvironment({ semanticKind: 'mcp', subject: clip(toolName || 'MCP tool', 80), detail: clip(toolName || 'MCP tool'), groupable: false, confidence: toolName ? 'high' : 'low' });
  }
  if (kind === 'subagent') {
    const subject = text(input.description || input.prompt || input.task || input.name || input.target || event.detail);
    return attachEnvironment({ semanticKind: 'subagent', subject: clip(subject, 80), detail: clip(subject), groupable: false, confidence: subject ? 'high' : 'low' });
  }
  return null;
}
