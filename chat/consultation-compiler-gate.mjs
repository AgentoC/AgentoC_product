// P5-T1: Consultation Compiler Gate.
//
// This module is the mandatory gate in front of consultation expert task
// compilation / dispatch. It owns three enforcement points from the
// Consultation V1 plan (docs/consultation-v1-implementation-plan-2026-08-14.md
// §3 C2/C3/C6, §4 ExpertAssignment/budget, §8 P5-T1):
//
//   1. taskKind=consultation is read-only by construction. readOnlyRequired is
//      always true and cannot be downgraded by a model; a write path
//      (non-empty writablePaths or accessMode='write') is rejected with
//      CONSULTATION_READONLY_VIOLATION (403) — consistent with the plan
//      compiler's existing check in chat/collaboration-plan.mjs.
//
//   2. Budget reservation. Compiling an expert task pre-reserves budget in the
//      round's `consult:<roundId>` scope ledger (C2) via
//      reserveConsultationBudget; over-limit raises
//      CONSULTATION_BUDGET_EXCEEDED (409). Delta is normalized from the task
//      estimate; idempotencyKey defaults to reservationId so replays never
//      double count.
//
//   3. Read-only expert capability. The compiled expert receives a versioned,
//      structured read-only capability description aligned with the run-scoped
//      collaboration-capability model: scope 'consultation', bound to
//      roundId + expertAssignmentId + controllerSessionId, operations
//      ['consultation.read'], readOnly: true. No write/create permission is
//      ever granted here.
//
// Error codes are imported from their owning modules (never re-declared):
//   CONSULTATION_READONLY_VIOLATION  → chat/collaboration-plan.mjs
//   CONSULTATION_BUDGET_EXCEEDED     → chat/organization-governor.mjs
//   CONSULTATION_EXPERT_ASSIGNMENT_INVALID → chat/consultation-store.mjs
import {
  CONSULTATION_READONLY_VIOLATION,
} from './collaboration-plan.mjs';
import {
  CONSULTATION_BUDGET_EXCEEDED,
  reserveConsultationBudget,
} from './organization-governor.mjs';
import {
  CONSULTATION_EXPERT_ASSIGNMENT_INVALID,
  getConsultationRound as defaultGetConsultationRound,
} from './consultation-store.mjs';

// Versioned schema for the read-only consultation capability description.
export const CONSULTATION_CAPABILITY_VERSION = 'consultation-capability/v1';
// Version of the gate's own contract surface (normalization + reservation + capability).
export const CONSULTATION_COMPILER_GATE_VERSION = 'consultation-compiler-gate/v1';

// Re-export the error codes referenced by the gate so callers/tests have a
// single import surface without re-declaring the strings.
export {
  CONSULTATION_READONLY_VIOLATION,
  CONSULTATION_BUDGET_EXCEEDED,
  CONSULTATION_EXPERT_ASSIGNMENT_INVALID,
};

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value) {
  return Array.isArray(value) ? [...new Set(value.map((item) => text(item)).filter(Boolean))] : [];
}

function normalizeRetry(value = {}) {
  const maxAttempts = Number.parseInt(String(value.maxAttempts ?? 1), 10);
  const retryOn = list(value.retryOn || ['transient']).filter((item) => (
    ['transient', 'unknown_outcome', 'deterministic_failure'].includes(item)
  ));
  return {
    maxAttempts: Number.isInteger(maxAttempts) && maxAttempts > 0 ? Math.min(maxAttempts, 5) : 1,
    retryOn: retryOn.length > 0 ? retryOn : ['transient'],
  };
}

function gateError(code, message, statusCode = 400, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

// Normalize a single consultation expert task. Mirrors collaboration-plan's
// normalizeTask shape but hard-freezes the consultation contract:
//   - taskKind is forced to 'consultation';
//   - readOnlyRequired is forced to true (a model cannot downgrade);
//   - writablePaths and accessMode are captured so the gate can reject a write
//     path with CONSULTATION_READONLY_VIOLATION before returning the read-only
//     projection.
function normalizeConsultationTask(task, index) {
  const id = text(task?.id || task?.taskId || task?.key) || `consult-expert-${index + 1}`;
  const role = text(task?.role || 'specialist').toLowerCase();
  const writablePaths = list(task?.writablePaths);
  const accessMode = ['read', 'write'].includes(text(task?.accessMode).toLowerCase())
    ? text(task?.accessMode).toLowerCase()
    : 'read';
  return {
    id,
    objective: text(task?.objective || task?.task),
    agentId: text(task?.agentId),
    role,
    taskKind: 'consultation',
    readOnlyRequired: true,
    dependsOn: list(task?.dependsOn),
    acceptance: list(task?.acceptance),
    writablePaths,
    accessMode,
    executionIsolation: ['shared', 'worktree', 'container'].includes(text(task?.executionIsolation).toLowerCase())
      ? text(task?.executionIsolation).toLowerCase()
      : undefined,
    runnerId: text(task?.runnerId) || undefined,
    runnerUnitScope: text(task?.runnerUnitScope) || undefined,
    workspaceMode: text(task?.workspaceMode),
    projectId: text(task?.projectId),
    retry: normalizeRetry(task?.retry),
    timeoutMs: Number.isInteger(task?.timeoutMs) && task.timeoutMs > 0
      ? Math.min(task.timeoutMs, 24 * 60 * 60 * 1000)
      : 20 * 60 * 1000,
  };
}

// Normalize a round's declared budget into governor-compatible limit fields.
// Accepts both the governor field names (maxTokens/maxCost/maxTotalRuns/...) and
// the round's plain dimension keys (tokens/cost/runs/...). Returns an object of
// `maxXxx` keys so it can be passed straight to reserveConsultationBudget, which
// re-normalizes them into per-dimension limits.
export function normalizeRoundBudget(budget = {}) {
  const source = budget && typeof budget === 'object' ? budget : {};
  const plainToMax = {
    agents: 'maxTotalAgents',
    runs: 'maxTotalRuns',
    retries: 'maxRetries',
    replans: 'maxReplans',
    sessionReplacements: 'maxSessionReplacements',
    tokens: 'maxTokens',
    cost: 'maxCost',
    elapsedMs: 'maxElapsedMs',
  };
  const limits = {};
  for (const [plain, maxField] of Object.entries(plainToMax)) {
    const value = source[maxField] !== undefined ? source[maxField] : source[plain];
    if (value !== undefined) limits[maxField] = value;
  }
  return limits;
}

/**
 * Build the versioned read-only capability description for a consultation
 * expert. This is a structured, self-describing object (no bearer token, no
 * signature — the collaboration-capability module owns signed run capabilities;
 * this gate only produces the read-only description a dispatch flow attaches to
 * the expert). Scope is 'consultation', operations are restricted to
 * 'consultation.read', readOnly is always true, and the capability is bound to
 * roundId + expertAssignmentId + controllerSessionId. An optional TTL adds an
 * expiresAt; no write/create operation is ever included.
 */
export function buildConsultationReadOnlyCapability({
  roundId,
  expertAssignmentId,
  controllerSessionId,
  role = 'specialist',
  ttlMs = 0,
  now = new Date(),
} = {}) {
  const timestamp = now instanceof Date && !Number.isNaN(now.getTime())
    ? now.toISOString()
    : new Date().toISOString();
  const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(ttlMs))) : 0;
  const capability = {
    schema: CONSULTATION_CAPABILITY_VERSION,
    scope: 'consultation',
    readOnly: true,
    operations: Object.freeze(['consultation.read']),
    role: text(role) || 'specialist',
    bindings: Object.freeze({
      roundId: text(roundId),
      expertAssignmentId: text(expertAssignmentId),
      controllerSessionId: text(controllerSessionId),
    }),
    createdAt: timestamp,
  };
  if (ttl > 0) {
    capability.expiresAt = new Date(new Date(timestamp).getTime() + ttl).toISOString();
  }
  return Object.freeze(capability);
}

/**
 * Compile a consultation expert task through the gate:
 *
 *   1. Load/validate the round (an injected `round` object or `getRound`
 *      dependency is honored; default is getConsultationRound).
 *   2. Force the read-only contract: taskKind='consultation', readOnlyRequired
 *      always true; a write path (non-empty writablePaths or accessMode='write')
 *      raises CONSULTATION_READONLY_VIOLATION(403).
 *   3. Pre-reserve budget in the `consult:<roundId>` scope ledger. delta is the
 *      task estimate (default { agents: 1, runs: 1, tokens: 0, cost: 0 }),
 *      overridable by the caller; idempotencyKey defaults to reservationId;
 *      limits are normalized from round.budget. Over-limit raises
 *      CONSULTATION_BUDGET_EXCEEDED(409).
 *   4. Build the read-only expert capability.
 *
 * Returns `{ task, reservation, capability }` where `task` is the normalized
 * read-only projection, `reservation` is the governor reservation outcome
 * (including `reservation`, `replay`, `reserved`, `totals`), and `capability`
 * is the read-only capability description.
 */
export async function compileConsultationExpertTask({
  task,
  roundId,
  expertAssignmentId,
  controllerSessionId,
  reservationId,
  idempotencyKey,
  delta,
  round,
  getRound = defaultGetConsultationRound,
} = {}) {
  const resolvedRoundId = text(roundId) || (round && typeof round === 'object' ? text(round.id) : '');
  if (!resolvedRoundId) {
    throw gateError(CONSULTATION_EXPERT_ASSIGNMENT_INVALID, 'roundId is required to compile a consultation expert task', 400, { roundId });
  }
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw gateError(CONSULTATION_EXPERT_ASSIGNMENT_INVALID, 'a consultation expert task object is required', 400, { task });
  }
  if (typeof getRound !== 'function') {
    throw gateError(CONSULTATION_EXPERT_ASSIGNMENT_INVALID, 'getRound must be a function', 400, { getRound: typeof getRound });
  }

  let resolvedRound = round && typeof round === 'object' ? round : null;
  if (!resolvedRound) {
    resolvedRound = await getRound(resolvedRoundId);
  }
  if (!resolvedRound || typeof resolvedRound !== 'object' || !text(resolvedRound.id)) {
    throw gateError(CONSULTATION_EXPERT_ASSIGNMENT_INVALID, `consultation round ${resolvedRoundId} could not be resolved`, 400, { roundId: resolvedRoundId });
  }

  // 1) + 2) read-only enforcement.
  const normalized = normalizeConsultationTask(task, 0);
  if (normalized.writablePaths.length > 0 || normalized.accessMode === 'write') {
    throw gateError(
      CONSULTATION_READONLY_VIOLATION,
      `Consultation expert task must be read-only: ${normalized.id}`,
      403,
      { taskId: normalized.id, writablePaths: normalized.writablePaths, accessMode: normalized.accessMode },
    );
  }
  const readOnlyTask = Object.freeze({
    ...normalized,
    taskKind: 'consultation',
    readOnlyRequired: true,
    writablePaths: [],
    accessMode: 'read',
    dependsOn: [...normalized.dependsOn],
    acceptance: [...normalized.acceptance],
    retry: { ...normalized.retry },
  });

  // 3) budget reservation.
  const resolvedReservationId = text(reservationId)
    || `res:consult:${resolvedRoundId}:${text(expertAssignmentId) || 'expert'}`;
  const resolvedIdempotencyKey = text(idempotencyKey) || resolvedReservationId;
  const estimateDelta = {
    agents: 1,
    runs: 1,
    tokens: 0,
    cost: 0,
    ...(delta && typeof delta === 'object' && !Array.isArray(delta) ? delta : {}),
  };
  const reservation = await reserveConsultationBudget({
    roundId: resolvedRoundId,
    reservationId: resolvedReservationId,
    idempotencyKey: resolvedIdempotencyKey,
    delta: estimateDelta,
    limits: normalizeRoundBudget(resolvedRound.budget),
  });

  // 4) read-only capability.
  const capability = buildConsultationReadOnlyCapability({
    roundId: resolvedRoundId,
    expertAssignmentId: text(expertAssignmentId),
    controllerSessionId: text(controllerSessionId),
    role: readOnlyTask.role,
  });

  return { task: readOnlyTask, reservation, capability };
}
