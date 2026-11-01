// S17 structured Organization command boundary. This module does not expose
// Session primitives; all durable effects are delegated to a journal handler.
import {
  createOperation,
  reconcileOperation,
} from './organization-operations.mjs';

export const ORG_COMMAND_INVALID = 'ORG_COMMAND_INVALID';

export const ORGANIZATION_COMMAND_KINDS = Object.freeze(new Set([
  'proposeOrganization',
  'compileOrganizationProposal',
  'applyFrozenRevision',
  'delegateTask',
  'requestRole',
  'createManagedSession',
  'bindManagedSession',
  'replaceManagedSession',
  'requestReview',
  'submitReview',
  'retryTask',
  'completePhase',
  'applyPlanAmendment',
  'cancelOrganization',
  'manager.aggregate',
]));

const FORBIDDEN_COMMANDS = new Set([
  'createSession',
  'create_session',
  'forkSession',
  'fork_session',
  'spawnSession',
  'spawn_session',
  'sendMessage',
  'send_message',
  'writeDatabase',
  'write_database',
  'sql',
]);

const ALLOWED_FIELDS = new Set([
  'operationId', 'organizationId', 'commandKind', 'idempotencyKey',
  'actorNodeId', 'actorSessionId', 'revision', 'version', 'generation',
  'expectedVersion', 'expectedGeneration', 'payload',
]);

const FORGED_FIELDS = new Set([
  'internal', 'isInternal', 'internalFlag', 'system', 'admin', 'privileged',
  'force', 'bypass', 'rawSql', 'sql', 'sessionId', 'parentSessionId',
]);

function invalid(message, details = {}) {
  return Object.assign(new Error(message), { code: ORG_COMMAND_INVALID, statusCode: 400, ...details });
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function assertInteger(value, label) {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) throw invalid(`${label} must be a non-negative integer`);
}

function assertStructuredPayload(payload) {
  if (payload === undefined) return {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid('payload must be a JSON object');
  const forbiddenNested = ['internal', 'isInternal', 'rawSql', 'sql', 'sessionId', 'parentSessionId', 'createSession', 'forkSession', 'spawnSession'];
  for (const key of forbiddenNested) {
    if (Object.hasOwn(payload, key)) throw invalid(`payload contains a forbidden field: ${key}`, { field: key });
  }
  return payload;
}

export function validateOrganizationCommand(command = {}) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw invalid('organization command must be a JSON object');
  for (const key of Object.keys(command)) {
    if (!ALLOWED_FIELDS.has(key) || FORGED_FIELDS.has(key)) throw invalid(`organization command field is not allowed: ${key}`, { field: key });
  }
  const organizationId = text(command.organizationId);
  const commandKind = text(command.commandKind);
  const idempotencyKey = text(command.idempotencyKey);
  const actorNodeId = text(command.actorNodeId);
  const actorSessionId = text(command.actorSessionId);
  if (!organizationId || !commandKind || !idempotencyKey || !actorNodeId || !actorSessionId) {
    throw invalid('organizationId, commandKind, idempotencyKey, actorNodeId and actorSessionId are required');
  }
  if (!ORGANIZATION_COMMAND_KINDS.has(commandKind)) {
    if (FORBIDDEN_COMMANDS.has(commandKind)) throw invalid(`direct Session or database command is forbidden: ${commandKind}`);
    throw invalid(`unknown organization command: ${commandKind}`, { commandKind });
  }
  assertInteger(command.revision, 'revision');
  assertInteger(command.version, 'version');
  assertInteger(command.generation, 'generation');
  assertInteger(command.expectedVersion, 'expectedVersion');
  assertInteger(command.expectedGeneration, 'expectedGeneration');
  const payload = assertStructuredPayload(command.payload);
  return {
    operationId: text(command.operationId) || undefined,
    organizationId,
    commandKind,
    idempotencyKey,
    actorNodeId,
    actorSessionId,
    revision: command.revision,
    version: command.version,
    generation: command.generation,
    payload,
  };
}

function requiresManagerAuthorization(commandKind) {
  return ['delegateTask', 'requestRole', 'createManagedSession', 'bindManagedSession', 'replaceManagedSession', 'manager.aggregate'].includes(commandKind);
}

export async function dispatchOrganizationCommand(command, {
  authorizeCommand,
  stepHandlers = {},
  autoAdvance = false,
  maxSteps = 16,
} = {}) {
  const normalized = validateOrganizationCommand(command);
  if (requiresManagerAuthorization(normalized.commandKind)) {
    if (typeof authorizeCommand !== 'function') throw invalid(`authorization callback is required for ${normalized.commandKind}`);
    const allowed = await authorizeCommand(normalized);
    if (allowed !== true) throw invalid(`actor is not authorized for ${normalized.commandKind}`);
  }
  const operation = await createOperation(normalized);
  if (!autoAdvance) return operation;
  return reconcileOperation(operation.operationId, { stepHandlers, maxSteps });
}

export { FORBIDDEN_COMMANDS };
