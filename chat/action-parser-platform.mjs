import { redactSensitiveText } from './tool-call-schema.mjs';

function text(value) { return typeof value === 'string' ? value.trim() : ''; }

function clip(value, max = 160) {
  const safe = redactSensitiveText(text(value)).replace(/\s+/g, ' ');
  return safe.length <= max ? safe : `${safe.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function basename(value) {
  return text(value).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || text(value);
}

function tokenizePowerShell(command) {
  const tokens = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const char of String(command || '')) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '`' && !quote) { escaped = true; continue; }
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
  return { tokens, dynamic: Boolean(quote) || /[{}$()]/.test(command || '') };
}

function tokenizeCmd(command) {
  const tokens = [];
  let current = '';
  let quote = false;
  let escaped = false;
  for (const char of String(command || '')) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '^') { escaped = true; continue; }
    if (char === '"') { quote = !quote; continue; }
    if (!quote && /\s/.test(char)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return { tokens, dynamic: Boolean(quote) || /[%!]/.test(command || '') };
}

function normalizeExecutable(value) {
  return text(value).replace(/[\\/]+$/, '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/i, '');
}

function argsAfter(tokens, index) {
  return tokens.slice(index + 1).filter((arg) => arg && !arg.startsWith('-') && !arg.startsWith('/'));
}

function action(semanticKind, subject, detail, rawCommand, confidence = 'high', groupable = true) {
  return {
    semanticKind,
    subject: clip(subject, 80),
    detail: clip(detail, 320),
    groupable,
    confidence,
    rawCommand: clip(rawCommand, 320),
  };
}

export function inferShellKind({ executionPlatform = process.platform, shellKind = '', shellPath = '', command = '' } = {}) {
  const explicit = text(shellKind).toLowerCase();
  if (explicit) return explicit;
  const path = text(shellPath).toLowerCase();
  const first = text(command).toLowerCase();
  if (path.includes('powershell') || path.endsWith('pwsh')) return 'powershell';
  if (path.endsWith('cmd.exe') || first.startsWith('cmd ') || first.startsWith('cmd.exe ')) return 'cmd';
  if (executionPlatform === 'win32') {
    const commandName = first.split(/\s+/, 1)[0].replace(/\.exe$/, '');
    if (['dir', 'type', 'findstr', 'ver', 'where', 'cd', 'chdir'].includes(commandName)) return 'cmd';
    return 'powershell';
  }
  if (executionPlatform === 'darwin') return 'zsh';
  return 'bash';
}

export function parsePowerShellCommand(command, { cwd = '' } = {}) {
  const raw = text(command);
  if (!raw) return null;
  const { tokens, dynamic } = tokenizePowerShell(raw);
  if (dynamic || /(?:\||&&|;|<|>)/.test(raw)) return action('execute', 'PowerShell command', raw, raw, 'low', false);
  let index = 0;
  if (['powershell', 'pwsh'].includes(normalizeExecutable(tokens[0])) && tokens[1]) {
    const commandFlag = tokens.findIndex((token) => ['-command', '-c', '-encodedcommand'].includes(token.toLowerCase()));
    if (commandFlag >= 0 && tokens[commandFlag + 1]) return parsePowerShellCommand(tokens[commandFlag + 1], { cwd });
    index = 1;
  }
  const executable = normalizeExecutable(tokens[index]);
  const args = argsAfter(tokens, index);
  if (['rg', 'ripgrep', 'grep'].includes(executable)) {
    const query = args[0] || '';
    const searchPath = args[1] || text(cwd);
    return action('search', [query, searchPath].filter(Boolean).join(' in '), [query, searchPath].filter(Boolean).join(' · '), raw);
  }
  if (executable === 'git' && ['status', 'diff', 'log', 'branch'].includes(args[0])) {
    const subjects = { status: 'workspace status', diff: 'workspace changes', log: 'commit history', branch: 'branches' };
    return action('inspect', subjects[args[0]], raw, raw, 'medium');
  }
  const path = args.find((arg) => !arg.startsWith('-')) || text(cwd) || '.';
  if (['get-content', 'gc', 'cat', 'get-item', 'gi', 'get-filehash'].includes(executable)) {
    return action('read', basename(path), path, raw);
  }
  if (['get-childitem', 'gci', 'dir', 'ls'].includes(executable)) {
    return action('list', path, path, raw);
  }
  if (['select-string', 'sls'].includes(executable)) {
    const query = args.find((arg) => !arg.startsWith('-')) || '';
    return action('search', query, [query, path].filter(Boolean).join(' · '), raw);
  }
  if (['get-location', 'pwd', 'test-path', 'get-command', 'get-service', 'get-process'].includes(executable)) {
    return action('inspect', executable === 'pwd' ? 'current location' : executable, raw, raw, 'medium');
  }
  if (['set-content', 'add-content', 'new-item'].includes(executable)) return action('edit', basename(path), path, raw);
  if (['copy-item'].includes(executable)) return action('execute', 'copy item', raw, raw, 'medium', false);
  if (['move-item'].includes(executable)) return action('execute', 'move item', raw, raw, 'medium', false);
  if (['remove-item'].includes(executable)) return action('execute', 'remove item', raw, raw, 'low', false);
  return action('execute', raw, raw, raw, 'low', false);
}

export function parseCmdCommand(command, { cwd = '' } = {}) {
  const raw = text(command);
  if (!raw) return null;
  const { tokens, dynamic } = tokenizeCmd(raw);
  if (dynamic || /(?:\||&&|&|<|>)/.test(raw)) return action('execute', 'CMD command', raw, raw, 'low', false);
  let index = 0;
  if (['cmd', 'cmd.exe'].includes(normalizeExecutable(tokens[0]))) {
    const commandFlag = tokens.findIndex((token) => ['/c', '/k'].includes(token.toLowerCase()));
    if (commandFlag >= 0 && tokens[commandFlag + 1]) return parseCmdCommand(tokens[commandFlag + 1], { cwd });
    index = 1;
  }
  const executable = normalizeExecutable(tokens[index]);
  const args = argsAfter(tokens, index);
  const path = args.find((arg) => !arg.startsWith('/')) || text(cwd) || '.';
  if (['type', 'more'].includes(executable)) return action('read', basename(path), path, raw);
  if (executable === 'dir') return action('list', path, path, raw);
  if (executable === 'findstr') {
    const query = args[0] || '';
    return action('search', query, [query, path].filter(Boolean).join(' · '), raw);
  }
  if (['cd', 'chdir', 'where', 'ver', 'set', 'echo'].includes(executable)) return action('inspect', executable, raw, raw, 'medium');
  return action('execute', raw, raw, raw, 'low', false);
}

export function parsePlatformShellCommand(command, options = {}) {
  const shellKind = inferShellKind({ ...options, command });
  if (shellKind === 'cmd') return parseCmdCommand(command, options);
  if (shellKind === 'powershell' || shellKind === 'pwsh' || shellKind === 'powershell-5.1') return parsePowerShellCommand(command, options);
  return null;
}
