// S25 startup reconciliation for the Autonomous Organization plane.
//
// Canonical stores remain the authority. This module only performs bounded,
// CAS-protected recovery of leases that are explicitly reclaimable and
// resumes journal steps through the supplied handlers. Missing provider,
// Session, Run, or ResultPacket facts are reported as blockers; they are never
// inferred to be successful.
import { createHash } from 'crypto';
import { ORG_RECOVERY_V1_ENABLED, ORG_SCHEMA_ENABLED } from '../lib/config.mjs';
import { canonicalJson } from './execution-scope.mjs';
import {
  initializeOrganizationStore,
  listOrganizations,
  listOrganizationNodes,
  listOrganizationGates,
} from './organization-store.mjs';
import { initializeOrganizationMessaging, listInternalEnvelopes, listExpiredInternalEnvelopes, reclaimExpiredInternalEnvelope, appendOrganizationEvent } from './organization-messaging.mjs';
import { initializeOrganizationOperations, listOperations, reconcileOperation } from './organization-operations.mjs';
import { initializeOrganizationGovernor, listBudgetCounters, releaseExpiredOrganizationBudgetReservations, releaseExpiredConsultationBudgetReservations } from './organization-governor.mjs';
import { initializeCollaborationStore, getCollaboration, listCollaborationRecords, listExpiredAttempts, requeueExpiredAttempt, refreshBarrier } from './collaboration-store.mjs';
import { listManagerAggregations, reclaimExpiredManagerAggregation } from './organization-hierarchy.mjs';
import { expireConsultationRoundsPastDeadline, consultationOrphanedPlannedRounds, cancelConsultationRound } from './consultation-store.mjs';

export const ORGANIZATION_RECONCILER_SCHEMA_VERSION = 1;
export const ORG_RECONCILIATION_INVALID = 'ORG_RECONCILIATION_INVALID';

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function integer(value, fallback = 0) { return Number.isInteger(value) && value >= 0 ? value : fallback; }
function nowDate(value) { return value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date(); }
function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}
function safeError(error) {
  return { code: text(error?.code) || 'ORG_RECONCILIATION_ERROR', message: text(error?.message) || String(error) };
}
function sortById(left, right) { return String(left?.id || left?.organizationId || '').localeCompare(String(right?.id || right?.organizationId || '')); }

function recoveryError(errors, area, error, details = {}) {
  errors.push({ area, ...details, error: safeError(error) });
}

function boundedSteps(value, fallback = 16) {
  return Math.max(1, Math.min(100, integer(value, fallback) || fallback));
}

function startupFailure(error, area = 'startup') {
  const entry = { area, error: safeError(error) };
  const organization = {
    schemaVersion: ORGANIZATION_RECONCILER_SCHEMA_VERSION,
    organizationId: '',
    state: 'unknown',
    revision: 0,
    progressEpoch: 0,
    status: 'blocked',
    counts: {},
    blockers: [{ code: 'RECONCILIATION_ERROR', area }],
    recovery: {
      operationsAdvanced: 0,
      envelopesReclaimed: 0,
      aggregationsReclaimed: 0,
      attemptsReconciled: 0,
      attemptsRetried: 0,
      budgetReservationsReleased: 0,
      audit: [],
    },
    digest: '',
    generatedAt: '',
    errors: [entry],
  };
  const stable = {
    schemaVersion: ORGANIZATION_RECONCILER_SCHEMA_VERSION,
    enabled: true,
    status: 'blocked',
    organizations: [organization],
    blockers: [{ code: 'RECONCILIATION_ERROR', area }],
    errors: [entry],
  };
  organization.digest = digest(organization);
  organization.generatedAt = new Date().toISOString();
  return { ...stable, digest: digest(stable), generatedAt: organization.generatedAt };
}

function recoveryAdapters(overrides = {}) {
  return {
    listOrganizations,
    listOrganizationNodes,
    listOrganizationGates,
    listInternalEnvelopes,
    listExpiredInternalEnvelopes,
    reclaimExpiredInternalEnvelope,
    appendOrganizationEvent,
    listOperations,
    reconcileOperation,
    listBudgetCounters,
    releaseExpiredOrganizationBudgetReservations,
    releaseExpiredConsultationBudgetReservations,
    listCollaborationRecords,
    getCollaboration,
    listExpiredAttempts,
    requeueExpiredAttempt,
    refreshBarrier,
    // A terminal Run is stronger evidence than an elapsed Attempt deadline.
    // Delegate this check to the shared collaboration reconciler so the
    // organization plane cannot invent its own timeout race. Lazy loading
    // avoids making startup imports circular.
    settleCollaborationRun: async (runId) => {
      const { getDefaultCollaborationOrchestrator } = await import('./collaboration-orchestrator.mjs');
      return getDefaultCollaborationOrchestrator().completeRun(runId);
    },
    listManagerAggregations,
    reclaimExpiredManagerAggregation,
    expireConsultationRoundsPastDeadline,
    consultationOrphanedPlannedRounds,
    cancelConsultationRound,
    ...((overrides && typeof overrides === 'object') ? overrides : {}),
  };
}

function collaborationBelongsToOrganization(collaboration, organizationId) {
  return collaboration?.policy?.organizationId === organizationId;
}

function retryAllowed(task, attempt) {
  const retry = task?.retry || {};
  return Number(attempt?.attemptNumber || 0) < Number(retry.maxAttempts || 1)
    && Array.isArray(retry.retryOn)
    && retry.retryOn.includes('unknown_outcome');
}

async function reconcileOrganization(organization, {
  now,
  limit,
  operationStepHandlers = {},
  maxOperationSteps = 16,
  recoverExpiredAttempts = true,
  adapters = {},
} = {}) {
  const organizationId = organization.id;
  const services = recoveryAdapters(adapters);
  const errors = [];
  const audit = [];
  const recovery = {
    operationsAdvanced: 0,
    envelopesReclaimed: 0,
    aggregationsReclaimed: 0,
    attemptsReconciled: 0,
    attemptsRetried: 0,
    budgetReservationsReleased: 0,
    audit,
  };
  const advancedOperationIds = new Set();
  const auditedEventKeys = new Set();

  async function appendRecoveryAudit(input, area, id = '') {
    try {
      const event = await services.appendOrganizationEvent(input);
      auditedEventKeys.add(input.eventKey);
      audit.push({ eventId: event?.id || 0, eventKey: event?.eventKey || input.eventKey, type: event?.type || input.type, area, id });
      return event;
    } catch (error) {
      recoveryError(errors, `audit.${area}`, error, id ? { id } : {});
      return null;
    }
  }

  async function safeRead(area, fn, fallback = [], details = {}) {
    try {
      return await fn();
    } catch (error) {
      recoveryError(errors, area, error, details);
      return fallback;
    }
  }

  const operations = await safeRead('operations', () => services.listOperations(organizationId, { limit }));
  let operationResults = [];
  const recoverableOperationStates = new Set(['requested', 'validated', 'facts_created', 'external_effect_created', 'bound', 'failed_retryable', 'reconciled']);
  for (const operation of operations.filter((entry) => recoverableOperationStates.has(entry.state))) {
    try {
      const result = await services.reconcileOperation(operation.operationId, {
        stepHandlers: operationStepHandlers,
        maxSteps: boundedSteps(maxOperationSteps),
      });
      operationResults.push(result);
      if (result && result.state !== operation.state) {
        recovery.operationsAdvanced += 1;
        advancedOperationIds.add(result.operationId);
        await appendRecoveryAudit({
          organizationId,
          eventKey: `recovery:operation:${result.operationId}:generation:${result.generation}`,
          type: 'recovery.operation_reconciled',
          organizationRevision: result.revision,
          nodeId: result.actorNodeId,
          actorNodeId: result.actorNodeId,
          actorSessionId: result.actorSessionId,
          payloadRef: { kind: 'organization_operation', operationId: result.operationId, generation: result.generation },
          payload: { state: result.state, currentStep: result.currentStep },
        }, 'operation', result.operationId);
      }
    } catch (error) {
      recoveryError(errors, 'operation', error, { id: operation.operationId });
    }
  }

  const expiredEnvelopes = await safeRead('envelopes', () => services.listExpiredInternalEnvelopes(organizationId, { now, limit }));
  for (const envelope of expiredEnvelopes) {
    try {
      const recovered = await services.reclaimExpiredInternalEnvelope(envelope.envelopeId, {
        expectedGeneration: envelope.deliveryGeneration,
        now,
      });
      if (recovered?.deliveryState === 'pending' && recovered.deliveryGeneration > envelope.deliveryGeneration) {
        recovery.envelopesReclaimed += 1;
        await appendRecoveryAudit({
          organizationId,
          eventKey: `recovery:envelope:${envelope.envelopeId}:generation:${envelope.deliveryGeneration}`,
          type: 'recovery.envelope_reclaimed',
          organizationRevision: envelope.organizationRevision,
          nodeId: envelope.toNodeId,
          payloadRef: { kind: 'internal_envelope', envelopeId: envelope.envelopeId, generation: envelope.deliveryGeneration },
          payload: { previousState: envelope.deliveryState, nextState: recovered.deliveryState },
        }, 'envelope', envelope.envelopeId);
      }
    } catch (error) {
      recoveryError(errors, 'envelope', error, { id: envelope.envelopeId });
    }
  }

  const aggregations = await safeRead('aggregations', () => services.listManagerAggregations(organizationId, { limit }));
  for (const aggregation of aggregations.filter((entry) => entry.state === 'claimed' && !entry.aggregationRunId)) {
    if (!aggregation.leaseUntil || new Date(aggregation.leaseUntil).getTime() > now.getTime()) continue;
    try {
      const recovered = await services.reclaimExpiredManagerAggregation(aggregation.aggregationId, {
        expectedGeneration: aggregation.generation,
        now,
      });
      const recoveredAggregation = recovered?.aggregation || recovered;
      if ((recovered?.reclaimed === true || recoveredAggregation?.state === 'ready')
        && recoveredAggregation?.generation > aggregation.generation) {
        recovery.aggregationsReclaimed += 1;
        await appendRecoveryAudit({
          organizationId,
          eventKey: `recovery:aggregation:${aggregation.aggregationId}:generation:${aggregation.generation}`,
          type: 'recovery.aggregation_reclaimed',
          organizationRevision: organization.currentRevision,
          nodeId: aggregation.managerNodeId,
          payloadRef: { kind: 'manager_aggregation', aggregationId: aggregation.aggregationId, generation: aggregation.generation },
          payload: { previousState: aggregation.state, nextState: recoveredAggregation.state },
        }, 'aggregation', aggregation.aggregationId);
      }
    } catch (error) {
      recoveryError(errors, 'aggregation', error, { id: aggregation.aggregationId });
    }
  }

  const activeCollaborations = (await safeRead('collaborations', () => services.listCollaborationRecords({ activeOnly: true })))
    .filter((entry) => collaborationBelongsToOrganization(entry, organizationId));
  const collaborationIds = new Set(activeCollaborations.map((entry) => entry.id));
  if (recoverExpiredAttempts) {
    const expiredAttempts = await safeRead('attempts', () => services.listExpiredAttempts(now));
    for (const attempt of expiredAttempts.filter((entry) => collaborationIds.has(entry.collaborationId))) {
      let collaboration = activeCollaborations.find((entry) => entry.id === attempt.collaborationId);
      try {
        if (attempt.runId && typeof services.settleCollaborationRun === 'function') {
          await services.settleCollaborationRun(attempt.runId);
          const refreshed = await services.getCollaboration(attempt.collaborationId).catch(() => null);
          const freshAttempt = refreshed?.attempts?.find((entry) => entry.id === attempt.id);
          // completeRun() may have terminalized (or recovered) this Attempt.
          // Never follow it with a stale unknown-outcome requeue.
          if (!freshAttempt || freshAttempt.state !== 'running') continue;
          collaboration = refreshed;
        }
        const task = collaboration?.tasks?.find((entry) => entry.id === attempt.taskId);
        const result = await services.requeueExpiredAttempt(attempt.id, {
          retry: retryAllowed(task, attempt),
          failureKind: 'unknown_outcome',
          reason: 'Attempt lease expired before a terminal result was observed',
          now,
        });
        if (result) {
          recovery.attemptsReconciled += 1;
          if (result.retryScheduled === true) recovery.attemptsRetried += 1;
          await appendRecoveryAudit({
            organizationId,
            eventKey: `recovery:attempt:${attempt.id}:attempt:${attempt.attemptNumber}`,
            type: 'recovery.attempt_reconciled',
            organizationRevision: organization.currentRevision,
            nodeId: collaboration?.policy?.organizationNodeId || '',
            payloadRef: { kind: 'collaboration_attempt', attemptId: attempt.id, taskId: attempt.taskId },
            payload: { previousState: 'running', nextState: result.state, retryScheduled: result.retryScheduled === true },
          }, 'attempt', attempt.id);
        }
      } catch (error) {
        recoveryError(errors, 'attempt', error, { id: attempt.id });
      }
    }
    for (const collaboration of activeCollaborations) {
      try {
        await services.refreshBarrier(collaboration.id);
      } catch (error) {
        recoveryError(errors, 'collaboration', error, { id: collaboration.id });
      }
    }
  }

  const [nodes, gates, envelopes, currentAggregations, initialCounters] = await Promise.all([
    safeRead('nodes', () => services.listOrganizationNodes(organizationId)),
    safeRead('gates', () => services.listOrganizationGates(organizationId)),
    safeRead('envelopes.read', () => services.listInternalEnvelopes(organizationId, { limit })),
    safeRead('aggregations.read', () => services.listManagerAggregations(organizationId, { limit })),
    safeRead('budget.read', () => services.listBudgetCounters(organizationId, { limit })),
  ]);
  let counters = initialCounters;
  for (const counter of counters) {
    try {
      const released = await services.releaseExpiredOrganizationBudgetReservations({
        organizationId,
        revision: counter.revision,
        now,
        limit,
      });
      for (const reservation of released) {
        recovery.budgetReservationsReleased += 1;
        await appendRecoveryAudit({
          organizationId,
          eventKey: `recovery:budget:${counter.revision}:${reservation.idempotencyKey}:released`,
          type: 'recovery.budget_reservation_released',
          organizationRevision: counter.revision,
          payloadRef: { kind: 'budget_reservation', reservationId: reservation.reservationId, idempotencyKey: reservation.idempotencyKey },
          payload: { reservationId: reservation.reservationId, idempotencyKey: reservation.idempotencyKey, reason: reservation.releaseReason || 'reservation expired' },
        }, 'budget', reservation.reservationId);
      }
    } catch (error) {
      recoveryError(errors, 'budget', error, { revision: counter.revision });
    }
  }
  // Re-read after releases so the projection does not report reservations that
  // this same reconciliation pass has already freed.
  counters = await safeRead('budget.read.after', () => services.listBudgetCounters(organizationId, { limit }), initialCounters);
  const reportOperations = await safeRead('operations.read.after', () => services.listOperations(organizationId, { limit }), operationResults);

  // Audit repair is derived from durable post-recovery facts. If the process
  // died after a CAS commit but before the append-only audit write, the next
  // startup reaches these same idempotent event keys and closes the evidence
  // gap without repeating the domain mutation.
  for (const operation of reportOperations.filter((entry) => advancedOperationIds.has(entry.operationId) || entry.state === 'reconciled')) {
    const eventKey = `recovery:operation:${operation.operationId}:generation:${operation.generation}`;
    if (auditedEventKeys.has(eventKey)) continue;
    await appendRecoveryAudit({
      organizationId,
      eventKey,
      type: 'recovery.operation_reconciled',
      organizationRevision: operation.revision,
      nodeId: operation.actorNodeId,
      actorNodeId: operation.actorNodeId,
      actorSessionId: operation.actorSessionId,
      payloadRef: { kind: 'organization_operation', operationId: operation.operationId, generation: operation.generation },
      payload: { state: operation.state, currentStep: operation.currentStep },
    }, 'operation', operation.operationId);
  }

  for (const envelope of envelopes) {
    if (envelope.deliveryState !== 'pending' || Number(envelope.deliveryGeneration) < 2) continue;
    const eventKey = `recovery:envelope:${envelope.envelopeId}:generation:${Number(envelope.deliveryGeneration) - 1}`;
    if (auditedEventKeys.has(eventKey)) continue;
    await appendRecoveryAudit({
      organizationId,
      eventKey,
      type: 'recovery.envelope_reclaimed',
      organizationRevision: envelope.organizationRevision,
      nodeId: envelope.toNodeId,
      payloadRef: { kind: 'internal_envelope', envelopeId: envelope.envelopeId, generation: Number(envelope.deliveryGeneration) - 1 },
      payload: { previousState: 'claimed', nextState: 'pending' },
    }, 'envelope', envelope.envelopeId);
  }
  for (const aggregation of currentAggregations) {
    if (aggregation.state !== 'ready' || Number(aggregation.generation) < 2) continue;
    const eventKey = `recovery:aggregation:${aggregation.aggregationId}:generation:${Number(aggregation.generation) - 1}`;
    if (auditedEventKeys.has(eventKey)) continue;
    await appendRecoveryAudit({
      organizationId,
      eventKey,
      type: 'recovery.aggregation_reclaimed',
      organizationRevision: organization.currentRevision,
      nodeId: aggregation.managerNodeId,
      payloadRef: { kind: 'manager_aggregation', aggregationId: aggregation.aggregationId, generation: Number(aggregation.generation) - 1 },
      payload: { previousState: 'claimed', nextState: 'ready' },
    }, 'aggregation', aggregation.aggregationId);
  }
  for (const counter of counters) {
    for (const reservation of Object.values(counter.reservations || {})) {
      if (reservation?.state !== 'released' || reservation.releaseReason !== 'reservation expired') continue;
      const eventKey = `recovery:budget:${counter.revision}:${reservation.idempotencyKey}:released`;
      if (auditedEventKeys.has(eventKey)) continue;
      await appendRecoveryAudit({
        organizationId,
        eventKey,
        type: 'recovery.budget_reservation_released',
        organizationRevision: counter.revision,
        payloadRef: { kind: 'budget_reservation', reservationId: reservation.reservationId, idempotencyKey: reservation.idempotencyKey },
        payload: { reservationId: reservation.reservationId, idempotencyKey: reservation.idempotencyKey, reason: reservation.releaseReason },
      }, 'budget', reservation.reservationId);
    }
  }
  for (const collaboration of activeCollaborations) {
    for (const attempt of collaboration.attempts || []) {
      if (attempt.state !== 'failed' || attempt.failureKind !== 'unknown_outcome' || !attempt.failureReason.startsWith('Attempt lease expired')) continue;
      const eventKey = `recovery:attempt:${attempt.id}:attempt:${attempt.attemptNumber}`;
      if (auditedEventKeys.has(eventKey)) continue;
      await appendRecoveryAudit({
        organizationId,
        eventKey,
        type: 'recovery.attempt_reconciled',
        organizationRevision: organization.currentRevision,
        nodeId: collaboration.policy?.organizationNodeId || '',
        payloadRef: { kind: 'collaboration_attempt', attemptId: attempt.id, taskId: attempt.taskId },
        payload: { previousState: 'running', nextState: attempt.state, retryScheduled: attempt.failureReason.startsWith('Attempt lease expired') && (collaboration.tasks || []).some((task) => task.id === attempt.taskId && task.state === 'retrying') },
      }, 'attempt', attempt.id);
    }
  }
  const pendingOperations = reportOperations.filter((entry) => !['completed', 'failed_terminal'].includes(entry.state));
  const activeNodesWithoutSession = nodes.filter((node) => node.lifecycleState === 'active' && !node.currentSessionId);
  const openGates = gates.filter((gate) => !['passed', 'needs_changes', 'decided', 'completed', 'cancelled'].includes(gate.state));
  const activeClaims = envelopes.filter((entry) => entry.deliveryState === 'claimed');
  const reservedBudgets = counters.reduce((count, counter) => count + Object.values(counter.reservations || {}).filter((entry) => entry?.state === 'reserved').length, 0);
  const activeAggregations = currentAggregations.filter((entry) => ['pending', 'claimed', 'ready'].includes(entry.state));
  const structuralIssues = [];
  for (const node of activeNodesWithoutSession) structuralIssues.push({ code: 'ACTIVE_NODE_UNBOUND', nodeId: node.id });
  for (const operation of pendingOperations.filter((entry) => entry.state === 'failed_retryable')) structuralIssues.push({ code: 'OPERATION_RETRY_PENDING', operationId: operation.operationId });
  for (const error of errors) structuralIssues.push({ code: 'RECONCILIATION_ERROR', area: error.area, id: error.id || '' });
  const pending = pendingOperations.length + openGates.length + activeAggregations.length + reservedBudgets;
  const status = structuralIssues.length > 0 ? 'blocked' : pending > 0 ? 'recovering' : 'healthy';
  const stable = {
    schemaVersion: ORGANIZATION_RECONCILER_SCHEMA_VERSION,
    organizationId,
    state: organization.state,
    revision: organization.currentRevision,
    progressEpoch: organization.progressEpoch,
    status,
    counts: {
      organizations: 1,
      nodes: nodes.length,
      activeNodesWithoutSession: activeNodesWithoutSession.length,
      gates: gates.length,
      openGates: openGates.length,
      envelopes: envelopes.length,
      activeEnvelopeClaims: activeClaims.length,
      operations: operations.length,
      pendingOperations: pendingOperations.length,
      aggregations: currentAggregations.length,
      activeAggregations: activeAggregations.length,
      reservedBudgets,
      collaborations: activeCollaborations.length,
    },
    blockers: structuralIssues,
  };
  return {
    ...stable,
    recovery,
    digest: digest(stable),
    generatedAt: now.toISOString(),
    errors,
  };
}

// C2 crash-recovery for consultation-scope reservations. Consult reservations
// live under `consult:<roundId>` and are not org-bound, so this step runs in
// the startup flow (not inside the per-organization loop). It releases every
// expired, unsettled consult reservation and reports the same
// `recovery.budget_reservation_released` event schema as the org path. When a
// reservation records an owning organizationId, the event is written to that
// organization's event log; otherwise it is tracked in the returned audit only
// (no org event is invented).
async function reconcileConsultationBudgetReservations({ now, limit, adapters = {} } = {}) {
  const services = recoveryAdapters(adapters);
  const audit = [];
  const errors = [];
  let reservationsReleased = 0;
  try {
    const released = await services.releaseExpiredConsultationBudgetReservations({ now, limit });
    for (const reservation of released) {
      reservationsReleased += 1;
      const eventKey = `recovery:budget:consult:${reservation.roundId}:${reservation.idempotencyKey}:released`;
      const eventInput = {
        eventKey,
        type: 'recovery.budget_reservation_released',
        organizationRevision: 0,
        payloadRef: { kind: 'budget_reservation', reservationId: reservation.reservationId, idempotencyKey: reservation.idempotencyKey, roundId: reservation.roundId },
        payload: { reservationId: reservation.reservationId, idempotencyKey: reservation.idempotencyKey, roundId: reservation.roundId, reason: reservation.releaseReason || 'reservation expired' },
      };
      const orgId = text(reservation.organizationId);
      if (!orgId) {
        audit.push({ eventId: 0, eventKey, type: eventInput.type, area: 'budget', id: reservation.reservationId });
        continue;
      }
      try {
        const event = await services.appendOrganizationEvent({ ...eventInput, organizationId: orgId });
        audit.push({ eventId: event?.id || 0, eventKey: event?.eventKey || eventKey, type: event?.type || eventInput.type, area: 'budget', id: reservation.reservationId });
      } catch (error) {
        recoveryError(errors, 'audit.budget', error, { id: reservation.reservationId });
      }
    }
  } catch (error) {
    recoveryError(errors, 'consult.budget', error);
  }
  return { reservationsReleased, audit, errors };
}

// P6-T3 round-level startup recovery for consultation rounds. Rounds are not
// org-bound, so this step runs in the startup flow alongside the consult budget
// sweep (reconcileConsultationBudgetReservations). Two recovery classes are
// handled:
//   - expired deadline: DISPATCHED/AGGREGATING rounds past `deadline` are moved
//     to EXPIRED via the store's batch expiry (C5 deadline rule).
//   - orphaned rounds: PLANNED rounds that have never been dispatched within
//     orphanAgeMs are cancelled with reason 'orphaned' (stale strategic
//     consultations are torn down instead of lingering forever).
// Both classes are audit-only — a round is not org-bound, so recovery is
// recorded in the returned audit array only, never as an org event. Errors are
// collected per-class under the 'consult.rounds' area and do not abort the
// sibling recovery steps.
export async function reconcileConsultationRounds({ now, orphanAgeMs = 24 * 60 * 60 * 1000, limit, adapters = {} } = {}) {
  const services = recoveryAdapters(adapters);
  const audit = [];
  const errors = [];
  const resolveNow = nowDate(now);
  let roundsExpired = 0;
  let roundsCancelled = 0;
  try {
    const expiredIds = await services.expireConsultationRoundsPastDeadline({ now: resolveNow, limit });
    for (const roundId of expiredIds) {
      roundsExpired += 1;
      audit.push({
        eventId: 0,
        eventKey: `recovery:consult:round:${roundId}:expired`,
        type: 'recovery.consultation_round_expired',
        area: 'consultation',
        id: roundId,
      });
    }
  } catch (error) {
    recoveryError(errors, 'consult.rounds', error, { phase: 'expire' });
  }
  try {
    const orphanIds = await services.consultationOrphanedPlannedRounds({ olderThanMs: orphanAgeMs, now: resolveNow, limit });
    for (const roundId of orphanIds) {
      try {
        await services.cancelConsultationRound(roundId, { reason: 'orphaned' });
        roundsCancelled += 1;
        audit.push({
          eventId: 0,
          eventKey: `recovery:consult:round:${roundId}:cancelled`,
          type: 'recovery.consultation_round_cancelled',
          area: 'consultation',
          id: roundId,
        });
      } catch (error) {
        recoveryError(errors, 'consult.rounds', error, { id: roundId, phase: 'cancel' });
      }
    }
  } catch (error) {
    recoveryError(errors, 'consult.rounds', error, { phase: 'orphan' });
  }
  return { roundsExpired, roundsCancelled, audit, errors };
}

export async function reconcileOrganizationsAtStartup(options = {}) {
  const enabled = options.enabled === true || ORG_RECOVERY_V1_ENABLED;
  if (!ORG_SCHEMA_ENABLED || !enabled) return { schemaVersion: ORGANIZATION_RECONCILER_SCHEMA_VERSION, enabled: false, organizations: [], digest: digest({ enabled: false, organizations: [] }) };
  const now = nowDate(options.now);
  const limit = Math.max(1, Math.min(5000, integer(options.limit, 500) || 500));
  try {
    await initializeCollaborationStore();
    await initializeOrganizationStore();
    await initializeOrganizationMessaging();
    await initializeOrganizationOperations();
    await initializeOrganizationGovernor();
  } catch (error) {
    return startupFailure(error, 'initialize');
  }
  let organizations;
  try {
    organizations = (await listOrganizations()).sort(sortById);
  } catch (error) {
    return startupFailure(error, 'organizations');
  }
  const reports = [];
  for (const organization of organizations) {
    try {
      reports.push(await reconcileOrganization(organization, { ...options, now, limit }));
    } catch (error) {
      reports.push(startupFailure(error, `organization:${organization.id}`).organizations[0]);
    }
  }
  const consultBudgetRecovery = await reconcileConsultationBudgetReservations({ now, limit, adapters: options.adapters });
  const consultRoundsRecovery = await reconcileConsultationRounds({ now, limit, orphanAgeMs: options.orphanAgeMs, adapters: options.adapters });
  const consultRecovery = {
    ...consultBudgetRecovery,
    rounds: { expired: consultRoundsRecovery.roundsExpired, cancelled: consultRoundsRecovery.roundsCancelled },
    audit: [...consultBudgetRecovery.audit, ...consultRoundsRecovery.audit],
    errors: [...consultBudgetRecovery.errors, ...consultRoundsRecovery.errors],
  };
  // consultRecovery is transient per-pass bookkeeping (like each organization's
  // `recovery` block) and is intentionally excluded from the stable projection so
  // the startup digest stays deterministic across replays.
  const stable = {
    schemaVersion: ORGANIZATION_RECONCILER_SCHEMA_VERSION,
    enabled: true,
    organizations: reports.map(({ generatedAt, errors, recovery, digest: _digest, ...report }) => report),
  };
  return {
    ...stable,
    organizations: reports,
    consultRecovery,
    digest: digest(stable),
    generatedAt: now.toISOString(),
    errors: reports.flatMap((report) => report.errors).concat(consultRecovery.errors),
  };
}

export async function reconcileOrganizationById(organizationId, options = {}) {
  if (!ORG_SCHEMA_ENABLED || !(options.enabled === true || ORG_RECOVERY_V1_ENABLED)) return null;
  const organizations = (await listOrganizations()).filter((organization) => organization.id === text(organizationId));
  if (organizations.length === 0) return null;
  return reconcileOrganization(organizations[0], { ...options, now: nowDate(options.now), limit: Math.max(1, Math.min(5000, integer(options.limit, 500) || 500)) });
}
