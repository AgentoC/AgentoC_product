const TRANSIENT_RECONNECT_TIMEOUT_RE =
  /^(?:error:\s*)?Reconnecting(?:\.{3}|…)\s+\d+\/\d+\s+\(timeout waiting for child process to exit\)$/i;
const CODEX_APP_SERVER_RUNTIME_FAMILY = 'codex-app-server-json';

const CODEX_APP_SERVER_LIFECYCLE_STATUS_RE =
  /^(?:idle|active|inProgress|in_progress|thinking|completed)$/i;
const CODEX_APP_SERVER_THREAD_STATUS_RE =
  /^Thread (?:ready|started) \([^)]+\)$/i;
const CODEX_APP_SERVER_MCP_LIFECYCLE_RE =
  /^MCP(?:\s+[^\s:]+)?\s+(?:starting|ready|started|connected|connecting|initializing|initialized|stopped|disabled|failed|error)$/i;
const CODEX_APP_SERVER_MODE_STATUS_RE = /^mode:\s*\S+/i;
const CODEX_APP_SERVER_GOAL_STATUS_RE = /^Goal(?: cleared|:)/i;
const CLAUDE_STREAM_RUNTIME_FAMILY = 'claude-stream-json';
const CLAUDE_LIFECYCLE_STATUS_RE = /^(?:requesting|responding|System: status|System: thinking_tokens)$/i;
const CLAUDE_SESSION_STARTED_RE = /^Session started \([^)]+\)$/i;
const CLAUDE_NORMAL_STOP_RE = /^stop:\s*(?:end_turn|tool_use|stop_sequence|max_tokens)$/i;

function isProviderRateLimitUsagePart(value) {
  const part = typeof value === 'string' ? value.trim() : '';
  if (!part) return false;
  if (/^(?:primary|secondary)\s+\d+(?:\.\d+)?%(?:\s*\/\s*\d+m)?$/i.test(part)) {
    return true;
  }
  return /^(?:no credits|credits ok)$/i.test(part);
}

export function isTransientProviderReconnectMessage(value) {
  const message = typeof value === 'string' ? value.trim() : '';
  return !!message && TRANSIENT_RECONNECT_TIMEOUT_RE.test(message);
}

export function isTransientProviderReconnectStatusEvent(event) {
  return event?.type === 'status'
    && isTransientProviderReconnectMessage(event.content);
}

export function isTransientProviderReconnectErrorPayload(payload) {
  if (!(payload && typeof payload === 'object')) return false;
  if (payload.type !== 'error') return false;
  return isTransientProviderReconnectMessage(payload.message);
}

export function isProviderUsageLimitMessage(value) {
  const message = typeof value === 'string' ? value.trim() : '';
  if (!/^Usage\s+\S/i.test(message)) return false;
  const parts = message.split(/\s+·\s+/);
  if (parts.length < 2) return false;
  const usageParts = parts.slice(1);
  return usageParts.some(isProviderRateLimitUsagePart)
    && usageParts.every(isProviderRateLimitUsagePart);
}

export function isProviderUsageLimitStatusEvent(event) {
  if (event?.type !== 'status') return false;
  if (event.codexRateLimits && typeof event.codexRateLimits === 'object') {
    return true;
  }
  return isProviderUsageLimitMessage(event.content);
}

export function isCodexAppServerLifecycleStatusMessage(value) {
  const message = typeof value === 'string' ? value.trim() : '';
  if (!message) return false;
  return CODEX_APP_SERVER_LIFECYCLE_STATUS_RE.test(message)
    || CODEX_APP_SERVER_THREAD_STATUS_RE.test(message)
    || CODEX_APP_SERVER_MCP_LIFECYCLE_RE.test(message)
    || CODEX_APP_SERVER_MODE_STATUS_RE.test(message)
    || CODEX_APP_SERVER_GOAL_STATUS_RE.test(message);
}

export function isCodexAppServerLifecycleStatusEvent(event) {
  if (event?.type !== 'status') return false;
  const content = typeof event.content === 'string'
    ? event.content
    : (typeof event.message === 'string' ? event.message : '');
  if (!isCodexAppServerLifecycleStatusMessage(content)) return false;
  return !!(event.runtimeFamily === CODEX_APP_SERVER_RUNTIME_FAMILY
    || event.provider === 'codex'
    || event.codexGoalEvent
    || event.codexMcpStatus
    || event.providerThreadId
    || CODEX_APP_SERVER_LIFECYCLE_STATUS_RE.test(content)
    || CODEX_APP_SERVER_MODE_STATUS_RE.test(content)
    || CODEX_APP_SERVER_GOAL_STATUS_RE.test(content)
    || CODEX_APP_SERVER_THREAD_STATUS_RE.test(content)
    || CODEX_APP_SERVER_MCP_LIFECYCLE_RE.test(content));
}

export function isClaudeLifecycleStatusEvent(event) {
  if (event?.type !== 'status') return false;
  const content = typeof event.content === 'string'
    ? event.content.trim()
    : (typeof event.message === 'string' ? event.message.trim() : '');
  if (!content) return false;
  const claudeEvent = event.runtimeFamily === CLAUDE_STREAM_RUNTIME_FAMILY
    || event.provider === 'claude'
    || typeof event.providerSessionId === 'string';
  if (!claudeEvent && !CLAUDE_LIFECYCLE_STATUS_RE.test(content)) return false;
  return CLAUDE_LIFECYCLE_STATUS_RE.test(content)
    || CLAUDE_SESSION_STARTED_RE.test(content)
    || CLAUDE_NORMAL_STOP_RE.test(content)
    || ['session_started', 'status', 'completed'].includes(String(event.providerLifecycle || ''));
}
