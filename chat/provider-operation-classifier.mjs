import { redactSensitiveText, redactSensitiveValue } from './tool-call-schema.mjs';
import { parseProviderAction } from './action-parser.mjs';
import {
  parseProviderToolInput,
  resolveProviderToolDialect,
} from './provider-tool-normalization.mjs';

const OPERATION_KINDS = new Set([
  'command',
  'read',
  'search',
  'file_edit',
  'web',
  'mcp',
  'subagent',
  'hook',
  'other',
]);

const FILE_EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'apply_patch', 'file_change']);
const READ_TOOLS = new Set(['read', 'readfile', 'read_file', 'get_file', 'readfilecontent', 'read_file_content']);
const SEARCH_TOOLS = new Set(['glob', 'grep', 'search', 'find', 'list', 'ls', 'ripgrep', 'search_files', 'find_files', 'list_files']);
const COMMAND_TOOLS = new Set(['bash', 'shell', 'command', 'commandexecution', 'exec', 'exec_command', 'run_command', 'execute_command', 'run_shell_command']);
const WEB_TOOLS = new Set(['websearch', 'webfetch', 'web_search', 'web_fetch']);
const SUBAGENT_TOOLS = new Set(['task', 'agent', 'subagent', 'spawn_agent']);
const MCP_TOOLS = new Set(['call_mcp_tool', 'mcp_tool', 'mcp_call']);

const TITLE_BY_KIND = Object.freeze({
  command: 'Running command',
  read: 'Reading file',
  search: 'Searching',
  file_edit: 'Editing file',
  web: 'Accessing web',
  mcp: 'Using tool',
  subagent: 'Running subtask',
  hook: 'Running hook',
  other: 'Using tool',
});

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clipSingleLine(value, maxChars = 320) {
  const normalized = redactSensitiveText(trimString(value)).replace(/\s+/g, ' ');
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function parseToolInput(value) {
  return parseProviderToolInput(value);
}

function readFirstString(source, keys = []) {
  for (const key of keys) {
    const value = trimString(source?.[key]);
    if (value) return value;
  }
  return '';
}

function normalizeToolName(value) {
  return trimString(value).toLowerCase();
}

function inferKind(event, normalizedToolName, dialect) {
  const explicitKind = trimString(event?.operationKind).toLowerCase();
  if (OPERATION_KINDS.has(explicitKind)) return explicitKind;
  const rawToolName = trimString(event?.toolName || event?.sourceToolName).toLowerCase();
  if (rawToolName.includes('/') || rawToolName.startsWith('mcp')) return 'mcp';
  if (OPERATION_KINDS.has(dialect?.operationKind)) return dialect.operationKind;
  if (event?.type === 'file_change') return 'file_edit';
  if (FILE_EDIT_TOOLS.has(normalizedToolName)) return 'file_edit';
  if (READ_TOOLS.has(normalizedToolName)) return 'read';
  if (SEARCH_TOOLS.has(normalizedToolName)) return 'search';
  if (COMMAND_TOOLS.has(normalizedToolName)) return 'command';
  if (WEB_TOOLS.has(normalizedToolName)) return 'web';
  if (SUBAGENT_TOOLS.has(normalizedToolName)) return 'subagent';
  if (MCP_TOOLS.has(normalizedToolName)) return 'mcp';
  if (normalizedToolName.includes('hook')) return 'hook';
  if (normalizedToolName.includes('/') || normalizedToolName.startsWith('mcp')) return 'mcp';
  return 'other';
}

function readCommand(event, input, kind) {
  const explicit = readFirstString(event, ['command']);
  if (explicit) return clipSingleLine(explicit);
  const inputCommand = readFirstString(input, ['command', 'cmd', 'script']);
  if (inputCommand) return clipSingleLine(inputCommand);
  if (kind !== 'command') return '';
  const rawInput = trimString(event?.toolInput);
  return input ? '' : clipSingleLine(rawInput);
}

function readDetail(event, input, kind, command, toolName) {
  const explicit = readFirstString(event, ['operationDetail', 'detail']);
  if (explicit) return clipSingleLine(explicit);
  if (command) return command;

  const filePath = readFirstString(event, ['filePath'])
    || readFirstString(input, ['file_path', 'path', 'notebook_path']);
  if (filePath) return clipSingleLine(filePath);

  if (kind === 'search') {
    const query = readFirstString(input, ['pattern', 'query', 'glob', 'needle']);
    const path = readFirstString(input, ['path', 'cwd', 'directory']);
    return clipSingleLine([query, path].filter(Boolean).join(' · '));
  }
  if (kind === 'web') {
    return clipSingleLine(readFirstString(input, ['query', 'url']));
  }
  if (kind === 'subagent') {
    return clipSingleLine(readFirstString(input, ['description', 'prompt', 'task', 'name']));
  }
  if (kind === 'mcp') {
    return clipSingleLine(readFirstString(input, ['toolName', 'tool_name', 'name']) || toolName);
  }
  return clipSingleLine(toolName);
}

export function classifyProviderOperation(event = {}) {
  const toolName = trimString(event.toolName || event.sourceToolName);
  // Durable event pages may externalize toolInput and provide only a bounded
  // preview. Use it only when it contains the complete body; a truncated JSON
  // fragment must never be interpreted as a command or file name.
  const preview = event.bodyField === 'toolInput' && event.bodyLoaded === false &&
    typeof event.bodyPreview === 'string' && Number.isInteger(event.bodyBytes) &&
    Buffer.byteLength(event.bodyPreview, 'utf8') === event.bodyBytes
    ? event.bodyPreview : '';
  const toolInput = event.toolInput || preview;
  const dialect = resolveProviderToolDialect({ toolName, toolInput });
  const normalizedToolName = dialect.normalizedToolName || normalizeToolName(toolName);
  const input = dialect.input && typeof dialect.input === 'object'
    ? dialect.input
    : parseToolInput(toolInput);
  const kind = inferKind(event, normalizedToolName, dialect);
  const command = clipSingleLine(dialect.command || readCommand({ ...event, toolInput }, input, kind));
  const cwd = clipSingleLine(readFirstString(event, ['cwd']) || readFirstString(input, ['cwd']), 240);
  const detail = clipSingleLine(readFirstString(event, ['operationDetail', 'detail'])
    || dialect.detail
    || dialect.subject
    || readDetail(event, input, kind, command, toolName));
  const action = parseProviderAction({
    ...event,
    operationKind: kind,
    operationSemanticKind: event.operationSemanticKind || dialect.semanticKind,
    operationSubject: event.operationSubject || dialect.subject,
    operationDetail: event.operationDetail || dialect.detail,
    command,
    input,
    providerActions: event.providerActions,
    executionPlatform: event.executionPlatform || event.platform,
    shellKind: event.shellKind || event.shell,
    shellPath: event.shellPath,
  });
  const providerTitle = clipSingleLine(readFirstString(event, ['operationTitle', 'providerTitle', 'title']), 160);
  const safeInput = input
    ? redactSensitiveValue(input)
    : (command ? { command } : {});

  const result = {
    kind,
    title: providerTitle || TITLE_BY_KIND[kind] || TITLE_BY_KIND.other,
    detail,
    ...(toolName ? { toolName: redactSensitiveText(toolName) } : {}),
    ...(Object.keys(safeInput).length > 0 ? { input: safeInput } : {}),
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(event.executionPlatform || event.platform ? { executionPlatform: String(event.executionPlatform || event.platform).trim() } : {}),
    ...(event.shellKind || event.shell ? { shellKind: String(event.shellKind || event.shell).trim() } : {}),
  };
  // Keep the legacy classifier shape enumerable for downstream consumers while
  // exposing the richer action metadata to the projection layer. The latter
  // reads result.action directly and persists it on the display projection.
  if (action) Object.defineProperty(result, 'action', { value: action, enumerable: false, configurable: true });
  return result;
}

export function getOperationTitle(kind) {
  const normalized = trimString(kind).toLowerCase();
  return TITLE_BY_KIND[normalized] || TITLE_BY_KIND.other;
}
