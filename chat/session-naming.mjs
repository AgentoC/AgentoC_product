export const DEFAULT_SESSION_NAME = 'new session';
const TEMP_SESSION_NAME_MAX_CHARS = 28;
const SESSION_GROUP_MAX_CHARS = 32;
const SESSION_DESCRIPTION_MAX_CHARS = 160;
const SESSION_CONTEXT_LABEL_MAX_CHARS = 64;
const GENERIC_SESSION_TITLE_KEYS = new Set([
  'app',
  'apps',
  'assistant',
  'automation',
  'bot',
  'bots',
  'chat',
  'chats',
  'connector',
  'connectors',
  'conversation',
  'conversations',
  'direct',
  'dm',
  'email',
  'emails',
  'feishu',
  'github',
  'group',
  'groups',
  'inbound',
  'issue',
  'issues',
  'lark',
  'mail',
  'main',
  'message',
  'messages',
  'new',
  'p2p',
  'pr',
  'pull',
  'request',
  'reply',
  'replies',
  'room',
  'rooms',
  'session',
  'sessions',
  'source',
  'sources',
  'thread',
  'threads',
  'topic',
  'topics',
  'voice',
  'wechat',
  'weixin',
  '会话',
  '对话',
  '新会话',
  '机器人',
  '线程',
  '群',
  '群组',
  '聊天',
  '私聊',
  '话题',
  '语音',
  '微信',
  '连接器',
  '邮件',
  '邮箱',
  '回复',
  '飞书',
]);
const SESSION_TITLE_STOPWORD_KEYS = new Set([
  'a',
  'an',
  'and',
  'at',
  'about',
  'by',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimSessionLabelDecorators(value) {
  return value
    .replace(/^[\s\-–—:：|/·•,，.]+/u, '')
    .replace(/[\s\-–—:：|/·•,，.]+$/u, '')
    .trim();
}

function normalizeContextLabel(value) {
  return normalizeSessionText(value, SESSION_CONTEXT_LABEL_MAX_CHARS);
}

function normalizeSessionLabelKey(value) {
  return normalizeContextLabel(value)
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function isChatSessionSource(context = {}) {
  const sourceId = normalizeContextLabel(context.sourceId || '').toLowerCase();
  const sourceName = normalizeContextLabel(context.sourceName || '').toLowerCase();
  return sourceId === 'chat' || sourceName === 'chat';
}

function isConnectorStyleSession(context = {}) {
  if (isChatSessionSource(context)) return false;
  const externalTriggerId = typeof context.externalTriggerId === 'string'
    ? context.externalTriggerId.trim()
    : '';
  if (externalTriggerId) return true;
  const sourceId = normalizeContextLabel(context.sourceId || '').toLowerCase();
  const sourceName = normalizeContextLabel(context.sourceName || '').toLowerCase();
  return !!(sourceId || sourceName);
}

function collectContextualSessionLabels(context = {}) {
  const labels = [
    normalizeSessionGroup(context.group || ''),
    normalizeContextLabel(context.sourceName || ''),
  ].filter(Boolean);
  return [...new Set(labels)].sort((a, b) => b.length - a.length);
}

function stripContextualSessionLabels(title, context = {}) {
  const normalizedTitle = normalizeSessionName(title);
  if (!normalizedTitle) return '';

  let nextTitle = normalizedTitle;
  const labels = collectContextualSessionLabels(context);
  if (labels.length === 0) {
    return trimSessionLabelDecorators(nextTitle);
  }

  let changed = true;
  while (changed && nextTitle) {
    changed = false;
    for (const label of labels) {
      const escapedLabel = escapeRegExp(label);
      const stripped = nextTitle
        .replace(new RegExp(`^${escapedLabel}(?:[\\s\\-–—:：|/·•,，.]+)?`, 'iu'), '')
        .replace(new RegExp(`(?:[\\s\\-–—:：|/·•,，.]+)?${escapedLabel}$`, 'iu'), '')
        .replace(/\s+/gu, ' ')
        .trim();
      const trimmed = trimSessionLabelDecorators(stripped);
      if (trimmed !== nextTitle) {
        nextTitle = trimmed;
        changed = true;
        if (!nextTitle) break;
      }
    }
  }

  return nextTitle;
}

function collectSessionTitleTokenKeys(title) {
  const matches = normalizeSessionName(title).match(/[\p{Letter}\p{Number}@._/#:-]+/gu) || [];
  return matches
    .map((token) => normalizeSessionLabelKey(token))
    .filter(Boolean);
}

function isMeaningfulConnectorTitle(title, context = {}) {
  const contextualKeys = new Set(
    collectContextualSessionLabels(context)
      .map((label) => normalizeSessionLabelKey(label))
      .filter(Boolean),
  );
  const informativeTokens = collectSessionTitleTokenKeys(title)
    .filter((key) => !SESSION_TITLE_STOPWORD_KEYS.has(key))
    .filter((key) => !GENERIC_SESSION_TITLE_KEYS.has(key))
    .filter((key) => !contextualKeys.has(key));
  if (informativeTokens.length === 0) return false;
  return informativeTokens.some((key) => key.length >= 2 || /\d/u.test(key));
}

export function normalizeContextualSessionTitle(title, context = {}) {
  return stripContextualSessionLabels(title, context);
}

function normalizeSessionText(value, maxChars) {
  const normalized = typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : '';
  if (!normalized) return '';
  return Array.from(normalized).slice(0, maxChars).join('');
}

export function normalizeSessionName(name) {
  return typeof name === 'string' ? name.trim() : '';
}

export function normalizeSessionGroup(group) {
  return normalizeSessionText(group, SESSION_GROUP_MAX_CHARS);
}

export function normalizeSessionDescription(description) {
  return normalizeSessionText(description, SESSION_DESCRIPTION_MAX_CHARS);
}

export function normalizeGeneratedSessionTitle(title, group) {
  const normalizedTitle = normalizeSessionName(title);
  if (!normalizedTitle) return '';
  const nextTitle = normalizeContextualSessionTitle(normalizedTitle, { group });
  return nextTitle || normalizedTitle;
}

export function resolveInitialSessionName(name, context = {}) {
  const normalized = normalizeSessionName(name);
  if (isConnectorStyleSession(context)) {
    if (normalized) {
      const contextualTitle = normalizeContextualSessionTitle(normalized, context);
      if (isMeaningfulConnectorTitle(contextualTitle, context)) {
        return {
          name: contextualTitle,
          autoRenamePending: false,
        };
      }
    }
    return {
      name: DEFAULT_SESSION_NAME,
      autoRenamePending: true,
    };
  }
  return {
    name: normalized || DEFAULT_SESSION_NAME,
    autoRenamePending: !normalized,
  };
}

export function isSessionAutoRenamePending(session) {
  if (!session) return true;
  if (typeof session === 'object' && Object.prototype.hasOwnProperty.call(session, 'autoRenamePending')) {
    return session.autoRenamePending === true;
  }
  const name = typeof session === 'string' ? session : session.name;
  return !normalizeSessionName(name) || normalizeSessionName(name) === DEFAULT_SESSION_NAME;
}

export function buildTemporarySessionName(text, maxChars = TEMP_SESSION_NAME_MAX_CHARS) {
  let normalized = typeof text === 'string'
    ? text
      .replace(/\r\n?/gu, '\n')
      .split('\n')
      .map((line) => line.replace(/^\s*(?:#{1,6}|[-*+]|>|\d+[.)])\s*/u, '').trim())
      .find(Boolean) || ''
    : '';
  if (!normalized) return '';

  // Remove conversational filler while keeping the requested action. The
  // value is only a fast provisional label; the foreground assistant turn
  // replaces it with semantic metadata at completion.
  normalized = normalized
    .replace(/^(?:请帮我|可以请你|我想让你|我需要你|麻烦你|劳烦你|请你|帮我|麻烦|劳烦|能否|可否|可以|请|我想)\s*/u, '')
    .replace(/^(?:please|could you|would you|can you|help me(?: to)?|i (?:want|need) you to)\s+/iu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return '';

  const clause = normalized.split(/[。！？!?；;\n]/u)[0]?.trim() || normalized;
  // A comma often separates the actual task from explanatory context. Keep
  // the full clause when it is already compact, otherwise prefer its first
  // meaningful segment.
  const commaHead = clause.split(/[,，]/u)[0]?.trim() || clause;
  normalized = Array.from(clause).length > maxChars && Array.from(commaHead).length >= 4
    ? commaHead
    : clause;

  const chars = Array.from(normalized);
  let head = chars.slice(0, maxChars).join('').trimEnd();
  // Avoid cutting an English title through the middle of a word when a
  // useful boundary exists near the cap.
  if (chars.length > maxChars && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(head)) {
    const boundary = head.lastIndexOf(' ');
    if (boundary >= Math.floor(maxChars * 0.55)) head = head.slice(0, boundary);
  }
  head = head.replace(/[\s,，.。:：\-–—]+$/u, '').trim();
  return chars.length > maxChars ? `${head}…` : head;
}
