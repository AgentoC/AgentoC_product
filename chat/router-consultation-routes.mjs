// P4-T1: Consultation V1 control-plane HTTP routes.
//
// Exposes the strategic consultation lifecycle (§7 of the plan) as owner-facing
// HTTP: create a round, inspect it, dispatch expert attempts, aggregate a typed
// decision, cancel, and list decisions. The implementation follows the
// router-organization-routes.mjs convention — handleXxxRoutes returns false when
// the path is not ours (so the router falls through) and true once it has taken
// the request. Dependencies (store, decisionStore, sessionFactory, readBody)
// are injectable for tests and default to the real implementations.
//
// Guard rails:
//   - CONSULTATION_V1_ENABLED off → route is not handled (return false).
//   - Missing/unsigned auth session → 401.
//   - Validation is delegated to chat/consultation-store.mjs (experts read-only,
//     quorum/deadline/round state/CAS). Errors are normalized to the §6 catalog:
//       404 CONSULTATION_NOT_FOUND
//       409 ROUND_STATE_INVALID / ROUND_STATE_CONFLICT / QUORUM_NOT_MET /
//           DEADLINE_EXPIRED
//       400 EXPERT_ASSIGNMENT_INVALID / GUARD_INVALID / DECISION_INVALID /
//           PACKET_INVALID
//     anything else falls back to error.statusCode || 400.
import { CONSULTATION_V1_ENABLED } from '../lib/config.mjs';
import { readBody as readRequestBody } from '../lib/utils.mjs';
import * as consultationStore from './consultation-store.mjs';
import { createManagedSessionForConsultation } from './organization-managed-session-factory.mjs';

function text(value) { return typeof value === 'string' ? value.trim() : ''; }

function authSessionId(authSession) {
  return text(authSession?.id || authSession?.rootSessionId || authSession?.sessionId);
}

function assertCapabilityAllowsConsultation(authSession) {
  if (authSession?.principalKind !== 'run_capability') return;
  if (text(authSession.capabilityOperation) !== 'session.consultation.manage') {
    throw httpError(
      'CONSULTATION_CAPABILITY_DENIED',
      'Run capability is not authorized for consultation control',
      403,
    );
  }
}

function assertCapabilityRoot(authSession, rootSessionId) {
  if (authSession?.principalKind !== 'run_capability') return;
  const capabilityRootSessionId = text(authSession.rootSessionId || authSession.sessionId);
  if (!capabilityRootSessionId || capabilityRootSessionId !== text(rootSessionId)) {
    throw httpError(
      'CONSULTATION_CAPABILITY_SCOPE',
      'Run capability is bound to another consultation root session',
      403,
    );
  }
}

function assertCapabilityRound(authSession, round) {
  assertCapabilityRoot(authSession, round?.rootSessionId);
}

function safeDecode(value) {
  if (value === undefined || value === null || value === '') return '';
  try { return decodeURIComponent(value); } catch { return String(value || ''); }
}

function httpError(code, message, statusCode, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

// §6 error → HTTP status normalization (P4-T1b work card mapping).
const CONSULTATION_STATUS_409 = new Set([
  consultationStore.CONSULTATION_ROUND_STATE_INVALID,
  consultationStore.CONSULTATION_ROUND_STATE_CONFLICT,
  consultationStore.CONSULTATION_QUORUM_NOT_MET,
  consultationStore.CONSULTATION_DEADLINE_EXPIRED,
]);
const CONSULTATION_STATUS_400 = new Set([
  consultationStore.CONSULTATION_EXPERT_ASSIGNMENT_INVALID,
  consultationStore.CONSULTATION_GUARD_INVALID,
  consultationStore.CONSULTATION_DECISION_INVALID,
  consultationStore.CONSULTATION_PACKET_INVALID,
]);

function consultationStatus(error) {
  const code = text(error?.code);
  if (code === 'BODY_TOO_LARGE') return 413;
  if (code === consultationStore.CONSULTATION_NOT_FOUND) return 404;
  if (CONSULTATION_STATUS_409.has(code)) return 409;
  if (CONSULTATION_STATUS_400.has(code)) return 400;
  return error?.statusCode || 400;
}

function writeError(res, writeJson, error) {
  const code = text(error?.code);
  writeJson(res, consultationStatus(error), {
    error: error?.message || 'Consultation request failed',
    ...(code ? { code } : {}),
  });
}

// Default real store/decision-store bindings. The handler merges any injected
// partial object over these so tests can swap individual functions.
const DEFAULT_STORE = Object.freeze({
  createConsultationRound: consultationStore.createConsultationRound,
  getConsultationRound: consultationStore.getConsultationRound,
  dispatchConsultationRound: consultationStore.dispatchConsultationRound,
  decideConsultationRound: consultationStore.decideConsultationRound,
  assertConsultationRoundDecidable: consultationStore.assertConsultationRoundDecidable,
  cancelConsultationRound: consultationStore.cancelConsultationRound,
});
const DEFAULT_DECISION_STORE = Object.freeze({
  createConsultationDecision: consultationStore.createConsultationDecision,
  listConsultationDecisions: consultationStore.listConsultationDecisions,
});

// Resolve which expert assignment a dispatch targets, mirroring the store's own
// resolver so the HTTP layer can create a managed session for the right expert
// before binding. Prefers an explicit expertAssignmentId, then an already-bound
// expertSessionId, then the next unbound `assigned` expert.
function resolveExpertAssignment(round, { expertAssignmentId, expertSessionId }) {
  const experts = Array.isArray(round?.experts) ? round.experts : [];
  if (expertAssignmentId) {
    return experts.find((expert) => expert.id === expertAssignmentId) || null;
  }
  if (expertSessionId) {
    const bound = experts.find((expert) => expert.expertSessionId === expertSessionId);
    if (bound) return bound;
    return experts.find((expert) => expert.status === 'assigned' && !expert.expertSessionId) || null;
  }
  return null;
}

async function readJsonBody(req, readBody, maxBytes = 32 * 1024) {
  const raw = await readBody(req, maxBytes);
  if (!raw || !String(raw).trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError('CONSULTATION_INVALID_JSON', 'Invalid JSON body', 400);
  }
}

export async function handleConsultationRoutes({
  req,
  res,
  pathname,
  authSession,
  writeJson,
  readBody = readRequestBody,
  store,
  decisionStore,
  sessionFactory,
}) {
  const match = /^\/api\/consultations(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(String(pathname || ''));
  if (!match) return false;
  if (!CONSULTATION_V1_ENABLED) return false;
  const requesterSessionId = authSessionId(authSession);
  if (!requesterSessionId) {
    writeJson(res, 401, { error: 'Authenticated session required' });
    return true;
  }
  try {
    assertCapabilityAllowsConsultation(authSession);
  } catch (error) {
    writeError(res, writeJson, error);
    return true;
  }

  const roundId = safeDecode(match[1]);
  const action = match[2] || '';
  const storeImpl = { ...DEFAULT_STORE, ...(store || {}) };
  const decisionStoreImpl = { ...DEFAULT_DECISION_STORE, ...(decisionStore || {}) };
  const createManagedSession = sessionFactory || createManagedSessionForConsultation;

  try {
    // POST /api/consultations — create a round (PLANNED).
    if (req.method === 'POST' && !roundId) {
      const payload = await readJsonBody(req, readBody);
      const rootSessionId = text(payload.rootSessionId) || requesterSessionId;
      assertCapabilityRoot(authSession, rootSessionId);
      const round = await storeImpl.createConsultationRound({
        rootSessionId,
        roundNumber: payload.roundNumber == null ? 1 : Number(payload.roundNumber),
        objective: text(payload.objective),
        question: text(payload.question),
        experts: payload.experts,
        quorum: payload.quorum == null ? undefined : Number(payload.quorum),
        budget: payload.budget,
        deadline: text(payload.deadline),
      });
      writeJson(res, 201, { round });
      return true;
    }

    // GET /api/consultations/:id — inspect a round (experts + packetIds).
    if (req.method === 'GET' && roundId && !action) {
      const round = await storeImpl.getConsultationRound(roundId);
      assertCapabilityRound(authSession, round);
      writeJson(res, 200, { round });
      return true;
    }

    // POST /api/consultations/:id/dispatch — bind an expert attempt.
    if (req.method === 'POST' && roundId && action === 'dispatch') {
      const payload = await readJsonBody(req, readBody);
      const round = await storeImpl.getConsultationRound(roundId);
      assertCapabilityRound(authSession, round);
      let expertAssignmentId = text(payload.expertAssignmentId);
      let expertSessionId = text(payload.expertSessionId);
      const attemptId = text(payload.attemptId);
      const agentId = text(payload.agentId);
      // agentId without an explicit expertSessionId → create a managed expert
      // session (C1 consultation lineage) before binding it.
      if (agentId && !expertSessionId) {
        const expert = resolveExpertAssignment(round, { expertAssignmentId, expertSessionId });
        if (!expert) {
          throw httpError(
            consultationStore.CONSULTATION_EXPERT_ASSIGNMENT_INVALID,
            `no dispatcheable expert for round ${roundId}`,
            400,
            { roundId },
          );
        }
        expertAssignmentId = expert.id;
        const created = await createManagedSession({
          rootSessionId: round.rootSessionId,
          consultationRoundId: roundId,
          expertAssignmentId: expert.id,
          controllerSessionId: requesterSessionId || round.rootSessionId,
          role: expert.role,
          agentId,
        });
        expertSessionId = text(created?.sessionId);
        if (!expertSessionId) {
          throw httpError(
            consultationStore.CONSULTATION_EXPERT_ASSIGNMENT_INVALID,
            `managed expert session creation returned no sessionId for round ${roundId}`,
            400,
            { roundId },
          );
        }
      }
      const updated = await storeImpl.dispatchConsultationRound(roundId, {
        ...(expertAssignmentId ? { expertAssignmentId } : {}),
        ...(expertSessionId ? { expertSessionId } : {}),
        ...(attemptId ? { attemptId } : {}),
        ...(payload.version != null ? { version: Number(payload.version) } : {}),
      });
      writeJson(res, 200, { round: updated });
      return true;
    }

    // POST /api/consultations/:id/decide — write a DecisionRecord then DECIDED.
    if (req.method === 'POST' && roundId && action === 'decide') {
      const payload = await readJsonBody(req, readBody);
      const round = await storeImpl.getConsultationRound(roundId);
      assertCapabilityRound(authSession, round);
      // Pre-flight: confirm the round is decidable (≥ quorum distinct experts,
      // unanimous vote digests) BEFORE persisting a DecisionRecord, so a round
      // that can never reach DECIDED (quorum/digest failure) does not leak a
      // decision record (C6: DecisionRecord is a decided outcome).
      await storeImpl.assertConsultationRoundDecidable(roundId, {
        ...(payload.version != null ? { version: Number(payload.version) } : {}),
      });
      const decision = await decisionStoreImpl.createConsultationDecision({
        roundId,
        decision: text(payload.decision),
        rationale: typeof payload.rationale === 'string' ? payload.rationale : undefined,
        requiredGuards: payload.requiredGuards,
        decidedBySessionId: text(payload.decidedBySessionId) || requesterSessionId,
        decidedByNodeId: text(payload.decidedByNodeId) || undefined,
        baseRevision: payload.baseRevision == null ? undefined : Number(payload.baseRevision),
        contextDigest: text(payload.contextDigest) || undefined,
        expiresAt: text(payload.expiresAt) || undefined,
      });
      const decidedRound = await storeImpl.decideConsultationRound(roundId, {
        ...(payload.version != null ? { version: Number(payload.version) } : {}),
        decisionRecordId: decision.id,
      });
      writeJson(res, 200, { round: decidedRound, decision });
      return true;
    }

    // POST /api/consultations/:id/cancel — cancel a non-terminal round.
    if (req.method === 'POST' && roundId && action === 'cancel') {
      const payload = await readJsonBody(req, readBody);
      const roundForCancel = await storeImpl.getConsultationRound(roundId);
      assertCapabilityRound(authSession, roundForCancel);
      const cancelledRound = await storeImpl.cancelConsultationRound(roundId, {
        ...(payload.version != null ? { version: Number(payload.version) } : {}),
        ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
      });
      writeJson(res, 200, { round: cancelledRound });
      return true;
    }

    // GET /api/consultations/:id/decisions — list DecisionRecords for a round.
    if (req.method === 'GET' && roundId && action === 'decisions') {
      const round = await storeImpl.getConsultationRound(roundId); // CONSULTATION_NOT_FOUND → 404
      assertCapabilityRound(authSession, round);
      const decisions = await decisionStoreImpl.listConsultationDecisions(roundId);
      writeJson(res, 200, { decisions });
      return true;
    }

    writeJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    writeError(res, writeJson, error);
  }
  return true;
}
