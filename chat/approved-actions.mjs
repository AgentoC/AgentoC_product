import { createHash, randomBytes } from 'crypto';
import { isAbsolute, resolve } from 'path';

import {
  CATEGORY_DELETE,
  CATEGORY_INSTALL,
  CATEGORY_OTHER,
  classifyPrivilegedOperation,
  stripSudo,
  tokenizeCommand,
} from './privileged-classifier.mjs';
import { classifyRisk } from './risk-classifier.mjs';
import { APPROVED_ACTION_EXECUTION_CLASS, isOwnerHostPasskeyRequired } from './approved-action-policy.mjs';
import { isApprovedActionSemanticProjectionIntact } from './approved-action-semantic.mjs';
import {
  AGENT_CREATE_CATEGORY,
  AGENT_CREATE_EXECUTION_CLASS,
  AGENT_CREATE_OPERATION,
  buildAgentCreateReviewSummary,
  computeAgentCreatePayloadHash,
  isAgentCreateApprovedAction,
  normalizeAgentCreatePayload,
} from './approved-agent-create.mjs';

export const APPROVED_ACTION_SCHEMA_VERSION = 1;
export const APPROVED_ACTION_CHANNEL = 'approved_action';
export const APPROVED_ACTION_BATCH_PREFIX = 'aab_';
export const APPROVED_ACTION_PREFIX = 'aa_';
export const APPROVED_ACTION_MAX_BATCH_SIZE = 32;
export const APPROVED_ACTION_MAX_COMMAND_BYTES = 8192;
export const APPROVED_ACTION_MAX_TEXT_BYTES = 4096;
export const APPROVED_ACTION_TTL_MS = 10 * 60 * 1000;

export const APPROVED_ACTION_STATE = Object.freeze({
  PROPOSED: 'proposed',
  CLASSIFIED: 'classified',
  WAITING_USER: 'waiting_user',
  AUTHORIZED: 'authorized',
  DENIED: 'denied',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const TERMINAL_STATES = new Set([
  APPROVED_ACTION_STATE.DENIED,
  APPROVED_ACTION_STATE.CANCELLED,
  APPROVED_ACTION_STATE.EXPIRED,
  APPROVED_ACTION_STATE.COMPLETED,
  APPROVED_ACTION_STATE.FAILED,
]);
const ALLOWED_TRANSITIONS = Object.freeze({
  [APPROVED_ACTION_STATE.PROPOSED]: new Set([APPROVED_ACTION_STATE.CLASSIFIED, APPROVED_ACTION_STATE.DENIED, APPROVED_ACTION_STATE.CANCELLED, APPROVED_ACTION_STATE.EXPIRED]),
  [APPROVED_ACTION_STATE.CLASSIFIED]: new Set([APPROVED_ACTION_STATE.WAITING_USER, APPROVED_ACTION_STATE.DENIED, APPROVED_ACTION_STATE.CANCELLED, APPROVED_ACTION_STATE.EXPIRED]),
  [APPROVED_ACTION_STATE.WAITING_USER]: new Set([APPROVED_ACTION_STATE.AUTHORIZED, APPROVED_ACTION_STATE.DENIED, APPROVED_ACTION_STATE.CANCELLED, APPROVED_ACTION_STATE.EXPIRED]),
  [APPROVED_ACTION_STATE.AUTHORIZED]: new Set([APPROVED_ACTION_STATE.EXECUTING, APPROVED_ACTION_STATE.DENIED, APPROVED_ACTION_STATE.CANCELLED, APPROVED_ACTION_STATE.EXPIRED]),
  [APPROVED_ACTION_STATE.EXECUTING]: new Set([APPROVED_ACTION_STATE.COMPLETED, APPROVED_ACTION_STATE.FAILED]),
});

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}${randomBytes(12).toString('hex')}`;
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function boundedText(value, field, maxBytes = APPROVED_ACTION_MAX_TEXT_BYTES) {
  const normalized = trimString(value);
  if (byteLength(normalized) > maxBytes) {
    const error = new Error(`${field} exceeds ${maxBytes} bytes`);
    error.code = 'APPROVED_ACTION_FIELD_TOO_LARGE';
    throw error;
  }
  return normalized;
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function commandBinding(command, argv) {
  if (typeof command !== 'string' || !Array.isArray(argv) || argv.length === 0 || argv.some(arg => typeof arg !== 'string')) return '';
  return sha256(JSON.stringify({ command, argv }));
}

function reviewedCommand(action) {
  if (!action?.commandBinding || !Array.isArray(action.argv)) return trimString(action?.canonicalCommand);
  return action.argv.map(arg => /^[A-Za-z0-9_./:@=+\\-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(' ');
}

function normalizeCwd(value) {
  const cwd = trimString(value);
  if (!cwd || !isAbsolute(cwd)) {
    const error = new Error('cwd must be an absolute path');
    error.code = 'APPROVED_ACTION_CWD_REQUIRED';
    throw error;
  }
  return resolve(cwd);
}

function reject(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function canonicalizeCommand(command) {
  const raw = boundedText(command, 'command', APPROVED_ACTION_MAX_COMMAND_BYTES);
  if (!raw) reject('APPROVED_ACTION_COMMAND_REQUIRED', 'command is required');
  if (/\0|[\r\n]/.test(raw)) reject('APPROVED_ACTION_COMMAND_INVALID', 'command contains a forbidden control character');

  const tokenized = tokenizeCommand(raw);
  if (tokenized.composite) reject('APPROVED_ACTION_COMPOSITE_COMMAND', 'composite shell commands are not allowed');
  const { tokens } = tokenized;
  const stripped = stripSudo(tokens);
  if (!stripped.program) reject('APPROVED_ACTION_COMMAND_INVALID', 'command has no executable');

  const leadingCount = stripped.sawSudo ? tokens.findIndex((token) => token !== 'sudo' && !/^-[-EuAknSb]+$/.test(token)) : 0;
  const canonicalTokens = leadingCount > 0 ? tokens.slice(leadingCount) : tokens;
  const forbidden = new Set(['sudo', 'su', 'doas', 'sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'fish', 'env']);
  if (canonicalTokens.some((token) => forbidden.has(String(token).toLowerCase()))) {
    reject('APPROVED_ACTION_NESTED_ESCALATION', 'nested privilege or shell launchers are not allowed');
  }
  if (canonicalTokens.some((token) => /^(python|python3|node|perl|ruby|php|pwsh|powershell)(?:\d+(?:\.\d+)?)?$/.test(String(token).toLowerCase()))) {
    reject('APPROVED_ACTION_INTERPRETER', 'interpreter launchers are not allowed');
  }
  return {
    command: canonicalTokens.join(' '),
    argv: canonicalTokens,
    sawLeadingSudo: stripped.sawSudo,
  };
}

function normalizeRequest(request = {}, fallbackRequestKey = '') {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    reject('APPROVED_ACTION_REQUEST_INVALID', 'action must be an object');
  }
  const requestKey = boundedText(request.requestKey || fallbackRequestKey, 'requestKey', 256);
  const description = boundedText(request.description, 'description');
  const reason = boundedText(request.reason, 'reason');
  return { requestKey, description, reason };
}

export function computeApprovedActionManifestHash({
  actionId = '',
  sessionId = '',
  runId = '',
  turnId = '',
  command = '',
  cwd = '',
  category = '',
  executionClass = '',
  risk = null,
  semanticManifestHash = '',
  operation = '',
  agentPayloadHash = '',
  commandBinding: binding = '',
  expiresAt = '',
} = {}) {
  const manifest = {
    schemaVersion: APPROVED_ACTION_SCHEMA_VERSION,
    actionId: trimString(actionId),
    sessionId: trimString(sessionId),
    runId: trimString(runId),
    turnId: trimString(turnId),
    command: trimString(command),
    cwd: trimString(cwd),
    category: trimString(category),
    executionClass: trimString(executionClass),
    riskTier: trimString(risk?.tier),
    semanticManifestHash: trimString(semanticManifestHash),
    expiresAt: trimString(expiresAt),
  };
  // Preserve the pre-product-operation hash byte-for-byte for in-flight
  // command approvals created before this adapter existed.
  if (trimString(operation) || trimString(agentPayloadHash)) {
    manifest.operation = trimString(operation);
    manifest.agentPayloadHash = trimString(agentPayloadHash);
  }
  // Older in-flight approvals used the original manifest encoding. New
  // command actions add an exact argument-vector binding without changing
  // the identity of already-persisted records.
  if (trimString(binding)) manifest.commandBinding = trimString(binding);
  return sha256(canonicalJson(manifest));
}

// The owner assertion binds the exact set selected in the approval surface.
// Per-action manifest hashes already bind command/cwd/run identity; this
// second hash prevents a caller from reusing a proof for a different subset.
export function computeApprovedActionSelectionHash(actions = []) {
  return sha256(canonicalJson((Array.isArray(actions) ? actions : [])
    .map((action) => ({
      actionId: trimString(action?.actionId),
      category: trimString(action?.category),
      executionClass: trimString(action?.executionClass),
      manifestHash: trimString(action?.manifestHash),
      semanticManifestHash: trimString(action?.semanticManifestHash),
    }))
    .sort((left, right) => left.actionId.localeCompare(right.actionId))));
}

export function classifyApprovedAction(action, context = {}) {
  if (isAgentCreateApprovedAction(action)
    || (action?.agentDefinition && typeof action.agentDefinition === 'object')) {
    return {
      category: AGENT_CREATE_CATEGORY,
      classification: {
        category: AGENT_CREATE_CATEGORY,
        operation: AGENT_CREATE_OPERATION,
        structured: true,
      },
      risk: { tier: 'danger', signals: { persistentProductMutation: true } },
      executionClass: AGENT_CREATE_EXECUTION_CLASS,
      needsPasskey: false,
      manifestHash: computeApprovedActionManifestHash({
        ...action,
        category: AGENT_CREATE_CATEGORY,
        executionClass: AGENT_CREATE_EXECUTION_CLASS,
        risk: { tier: 'danger' },
      }),
    };
  }
  const command = trimString(action?.canonicalCommand || action?.command);
  const privileged = classifyPrivilegedOperation({
    command,
    declaredCategory: action?.declaredCategory,
    cwd: action?.cwd,
  });
  const risk = classifyRisk({
    command,
    cwd: action?.cwd,
    projectRoot: context.projectRoot,
    home: context.home,
  });
  const hostRequested = action?.sawLeadingSudo === true
    || privileged.sawSudo === true
    || risk.signals?.needsPrivilegedExecution === true;
  const executionClass = hostRequested
    ? APPROVED_ACTION_EXECUTION_CLASS.HOST
    : APPROVED_ACTION_EXECUTION_CLASS.SESSION;
  if (risk.tier !== 'danger' && privileged.category !== CATEGORY_DELETE && !hostRequested) {
    reject('APPROVED_ACTION_NOT_REQUIRED', 'action does not require the approved action channel');
  }
  const manifestHash = computeApprovedActionManifestHash({
    ...action,
    category: privileged.category,
    executionClass,
    risk,
  });
  return {
    category: privileged.category,
    classification: privileged,
    risk,
    executionClass,
    // Server-projected approval signal: clients only run the passkey flow when
    // the owner policy still demands it. Host class alone is not sufficient.
    needsPasskey: executionClass === APPROVED_ACTION_EXECUTION_CLASS.HOST
      && isOwnerHostPasskeyRequired(),
    manifestHash,
  };
}

export function buildApprovedAction(input = {}, context = {}) {
  const request = normalizeRequest(input, context.requestKey);
  if (isAgentCreateApprovedAction(input)) {
    const agentPayload = normalizeAgentCreatePayload(input.agent);
    const agentPayloadHash = computeAgentCreatePayloadHash(agentPayload);
    const actionId = trimString(input.actionId) || createId(APPROVED_ACTION_PREFIX);
    const sessionId = boundedText(context.sessionId || input.sessionId, 'sessionId', 256);
    const runId = boundedText(context.runId || input.runId, 'runId', 256);
    const turnId = boundedText(context.turnId || input.turnId, 'turnId', 256);
    if (!sessionId || !runId || !turnId) reject('APPROVED_ACTION_BINDING_REQUIRED', 'sessionId, runId, and turnId are required');
    const base = {
      actionId,
      sessionId,
      runId,
      turnId,
      requestKey: request.requestKey,
      operation: AGENT_CREATE_OPERATION,
      originalRequest: {
        description: request.description || `Create Agent \"${agentPayload.name}\"`,
        reason: request.reason,
      },
      reviewSummary: buildAgentCreateReviewSummary(agentPayload),
      agentPayload,
      agentPayloadHash,
      canonicalCommand: '',
      argv: [],
      cwd: normalizeCwd(input.cwd || context.cwd),
      declaredCategory: AGENT_CREATE_CATEGORY,
      sawLeadingSudo: false,
      semanticProjection: context.semanticProjection || null,
      semanticManifestHash: trimString(context.semanticProjection?.semanticManifestHash),
      createdAt: nowIso(),
    };
    base.expiresAt = new Date(Date.parse(base.createdAt) + APPROVED_ACTION_TTL_MS).toISOString();
    const classified = classifyApprovedAction(base, context);
    return {
      schemaVersion: APPROVED_ACTION_SCHEMA_VERSION,
      channel: APPROVED_ACTION_CHANNEL,
      ...base,
      ...classified,
      state: APPROVED_ACTION_STATE.PROPOSED,
      authorization: null,
      resultRef: null,
      auditId: createId('aaudit_'),
    };
  }
  const canonical = canonicalizeCommand(input.command);
  const cwd = normalizeCwd(input.cwd || context.cwd);
  const actionId = trimString(input.actionId) || createId(APPROVED_ACTION_PREFIX);
  const sessionId = boundedText(context.sessionId || input.sessionId, 'sessionId', 256);
  const runId = boundedText(context.runId || input.runId, 'runId', 256);
  const turnId = boundedText(context.turnId || input.turnId, 'turnId', 256);
  if (!sessionId || !runId || !turnId) reject('APPROVED_ACTION_BINDING_REQUIRED', 'sessionId, runId, and turnId are required');

  const base = {
    actionId,
    sessionId,
    runId,
    turnId,
    requestKey: request.requestKey,
    originalRequest: {
      description: request.description || canonical.command.slice(0, 160),
      reason: request.reason,
    },
    canonicalCommand: canonical.command,
    argv: canonical.argv,
    commandBinding: commandBinding(canonical.command, canonical.argv),
    cwd,
    declaredCategory: boundedText(input.category || input.declaredCategory, 'category', 128),
    sawLeadingSudo: canonical.sawLeadingSudo,
    semanticProjection: context.semanticProjection || null,
    semanticManifestHash: trimString(context.semanticProjection?.semanticManifestHash),
    createdAt: nowIso(),
  };
  base.expiresAt = new Date(Date.parse(base.createdAt) + APPROVED_ACTION_TTL_MS).toISOString();
  const classified = classifyApprovedAction(base, context);
  return {
    schemaVersion: APPROVED_ACTION_SCHEMA_VERSION,
    channel: APPROVED_ACTION_CHANNEL,
    ...base,
    ...classified,
    state: APPROVED_ACTION_STATE.PROPOSED,
    authorization: null,
    resultRef: null,
    auditId: createId('aaudit_'),
  };
}

export function transitionApprovedAction(action, nextState, patch = {}) {
  const current = trimString(action?.state);
  const next = trimString(nextState);
  if (!Object.values(APPROVED_ACTION_STATE).includes(current)) reject('APPROVED_ACTION_STATE_INVALID', 'current action state is invalid');
  if (!Object.values(APPROVED_ACTION_STATE).includes(next)) reject('APPROVED_ACTION_STATE_INVALID', 'next action state is invalid');
  if (current === next) return { ...action, ...patch };
  if (!ALLOWED_TRANSITIONS[current]?.has(next)) {
    reject('APPROVED_ACTION_INVALID_TRANSITION', `cannot transition action from ${current} to ${next}`);
  }
  return {
    ...action,
    ...patch,
    state: next,
    updatedAt: nowIso(),
  };
}

export function isTerminalApprovedActionState(state) {
  return TERMINAL_STATES.has(trimString(state));
}

export function isApprovedActionExpired(action, now = Date.now()) {
  const expiresAt = Date.parse(trimString(action?.expiresAt));
  return Number.isFinite(expiresAt) && Number(now) >= expiresAt;
}

export function isApprovedActionManifestIntact(action) {
  if (!action || typeof action !== 'object') return false;
  if (action.commandBinding !== undefined && (!/^[a-f0-9]{64}$/.test(action.commandBinding) ||
      commandBinding(action.canonicalCommand, action.argv) !== action.commandBinding)) return false;
  if (isAgentCreateApprovedAction(action)) {
    try {
      if (computeAgentCreatePayloadHash(action.agentPayload) !== trimString(action.agentPayloadHash)) return false;
    } catch {
      return false;
    }
  }
  return computeApprovedActionManifestHash(action) === trimString(action.manifestHash)
    && isApprovedActionSemanticProjectionIntact(action);
}

export function redactApprovedActionText(value) {
  return String(value || '')
    .replace(/(--?(?:password|token|secret|api[-_]?key|authorization))(?:=|\s+)([^\s]+)/gi, '$1=[redacted]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)[A-Z0-9_]*)=([^\s]+)/g, '$1=[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]');
}

export function buildApprovedActionAuditEvent(action, event, details = {}) {
  const safeEvent = trimString(event);
  if (!safeEvent) reject('APPROVED_ACTION_AUDIT_EVENT_REQUIRED', 'audit event is required');
  return {
    type: 'approved_action_audit',
    role: 'system',
    channel: APPROVED_ACTION_CHANNEL,
    schemaVersion: APPROVED_ACTION_SCHEMA_VERSION,
    auditId: trimString(action?.auditId),
    actionId: trimString(action?.actionId),
    batchId: trimString(action?.batchId),
    sessionId: trimString(action?.sessionId),
    runId: trimString(action?.runId),
    event: safeEvent,
    at: nowIso(),
    command: redactApprovedActionText(action?.canonicalCommand),
    operation: trimString(action?.operation),
    reviewSummary: redactApprovedActionText(action?.reviewSummary),
    cwd: trimString(action?.cwd),
    category: trimString(action?.category),
    executionClass: trimString(action?.executionClass),
    manifestHash: trimString(action?.manifestHash),
    semanticManifestHash: trimString(action?.semanticManifestHash),
    ...details,
  };
}

// Owner-facing projection for the approval surface. The exact Agent definition
// is derived from the canonical, manifest-bound payload; raw semantic proofs,
// grant material, and executor-only fields never cross this boundary.
export function createApprovedActionClientProjection(action) {
  const internalAuthorization = action?.authorization && typeof action.authorization === 'object'
    ? action.authorization
    : null;
  const authorization = internalAuthorization
    ? {
        source: trimString(internalAuthorization.source),
        approvedAt: trimString(internalAuthorization.approvedAt),
        credentialId: trimString(internalAuthorization.credentialId),
        selectionManifestHash: trimString(internalAuthorization.selectionManifestHash),
      }
    : null;
  let agentDefinition = null;
  if (isAgentCreateApprovedAction(action)) {
    try {
      const payload = normalizeAgentCreatePayload(action?.agentPayload || action?.agentDefinition || {});
      agentDefinition = {
        name: payload.name,
        tool: payload.tool,
        skills: [...payload.skills],
        welcomeMessage: payload.welcomeMessage,
        systemPrompt: payload.systemPrompt,
        ...(payload.perMessageSystemPrompt
          ? { perMessageSystemPrompt: { ...payload.perMessageSystemPrompt } }
          : {}),
      };
    } catch {
      // A malformed persisted action is not made reviewable. Manifest and
      // executor validation will fail closed independently.
      agentDefinition = null;
    }
  }
  return {
    actionId: trimString(action?.actionId),
    description: trimString(action?.originalRequest?.description),
    summary: trimString(action?.reviewSummary),
    reason: trimString(action?.originalRequest?.reason),
    command: reviewedCommand(action),
    cwd: trimString(action?.cwd),
    category: trimString(action?.category),
    executionClass: trimString(action?.executionClass),
    state: trimString(action?.state),
    risk: trimString(action?.risk?.tier),
    needsPasskey: action?.needsPasskey === true,
    manifestHash: trimString(action?.manifestHash),
    authorization,
    resultRef: action?.resultRef || null,
    ...(agentDefinition ? { agentDefinition } : {}),
  };
}

export function createApprovedActionClientEventProjection(event) {
  if (event?.type !== 'approved_action_batch_request') return event;
  return {
    ...event,
    actions: Array.isArray(event.actions)
      ? event.actions.map(createApprovedActionClientProjection)
      : [],
  };
}

export function buildApprovedActionBatch(actions, context = {}) {
  if (!Array.isArray(actions) || actions.length === 0) reject('APPROVED_ACTION_BATCH_EMPTY', 'actions must contain at least one action');
  if (actions.length > APPROVED_ACTION_MAX_BATCH_SIZE) reject('APPROVED_ACTION_BATCH_TOO_LARGE', `actions may contain at most ${APPROVED_ACTION_MAX_BATCH_SIZE} entries`);
  const batchId = trimString(context.batchId) || createId(APPROVED_ACTION_BATCH_PREFIX);
  const requestKey = boundedText(context.requestKey, 'requestKey', 256);
  if (!requestKey) reject('APPROVED_ACTION_REQUEST_KEY_REQUIRED', 'requestKey is required');
  const built = actions.map((input, index) => buildApprovedAction(input, {
    ...context,
    requestKey,
    semanticProjection: Array.isArray(context.semanticProjections)
      ? context.semanticProjections[index] || null
      : context.semanticProjection,
  }));
  const actionIds = new Set();
  for (const action of built) {
    if (actionIds.has(action.actionId)) reject('APPROVED_ACTION_DUPLICATE_ID', 'actionId must be unique within a batch');
    actionIds.add(action.actionId);
  }
  return {
    schemaVersion: APPROVED_ACTION_SCHEMA_VERSION,
    channel: APPROVED_ACTION_CHANNEL,
    batchId,
    requestKey,
    sessionId: trimString(context.sessionId),
    runId: trimString(context.runId),
    turnId: trimString(context.turnId),
    state: APPROVED_ACTION_STATE.PROPOSED,
    createdAt: nowIso(),
    actions: built.map((action) => ({ ...action, batchId })),
  };
}

export function isApprovedActionCategory(category) {
  return [CATEGORY_INSTALL, CATEGORY_OTHER, CATEGORY_DELETE].includes(trimString(category));
}
