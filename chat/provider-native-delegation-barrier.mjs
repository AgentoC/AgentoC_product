/**
 * Provider-native delegation reducer and Join Barrier.
 *
 * This is an in-memory, deterministic runtime contract. Persistence and the
 * chat/run lifecycle own the durable record; this module only decides whether
 * a provider terminal candidate is safe to finalize.
 */

import {
  DELEGATION_ACTIVE_STATES,
  DELEGATION_TERMINAL_STATES,
  createDelegationProjector,
  isDelegationActive,
  isDelegationTerminal,
} from './delegation-canonical.mjs';

export const JOIN_BARRIER_PHASES = Object.freeze([
  'executing',
  'terminal_candidate',
  'awaiting_delegations',
  'aggregating',
  'completed',
  'failed',
  'cancelled',
]);

const TERMINAL_CANDIDATE_OUTCOMES = new Set(DELEGATION_TERMINAL_STATES);
const ACTIVE_STATE_SET = new Set(DELEGATION_ACTIVE_STATES);

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function clone(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
}

function failure(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

export function createProviderNativeDelegationReducer({ runId } = {}) {
  const boundRunId = trim(runId);
  const projector = createDelegationProjector();
  const records = new Map();
  const errors = [];
  const recoveryFailedDelegationIds = new Set();

  function recordEvent(event) {
    const current = records.get(event.delegationId) || {
      delegationId: event.delegationId,
      provider: event.provider,
      providerDelegationId: event.providerDelegationId,
      runId: event.runId,
      parentSessionId: event.parentSessionId,
      parentDelegationId: event.parentDelegationId || '',
      childSessionId: event.childSessionId || '',
      state: event.state,
      seq: event.seq,
      facts: null,
    };
    current.provider = event.provider;
    current.providerDelegationId = event.providerDelegationId;
    current.parentDelegationId = event.parentDelegationId || current.parentDelegationId;
    current.childSessionId = event.childSessionId || current.childSessionId;
    current.state = event.state === 'running' && event.kind === 'recovered' ? 'running' : event.state;
    current.seq = event.seq;
    if (event.facts) current.facts = event.facts;
    records.set(event.delegationId, current);
  }

  function apply(event) {
    if (!boundRunId) {
      errors.push('runId is required for delegation reducer');
      return failure('run_id_missing');
    }
    if (!event || event.runId !== boundRunId) {
      const reason = 'delegation event belongs to another run';
      errors.push(reason);
      return failure('cross_run_event');
    }
    const previousState = projector.getState(event.delegationId);
    const result = projector.apply(event);
    if (!result.ok) {
      errors.push(...result.errors);
      return failure('delegation_replay_invalid', { errors: result.errors });
    }
    if (previousState === 'lost' && event.kind === 'failed') {
      recoveryFailedDelegationIds.add(event.delegationId);
    }
    recordEvent(event);
    return { ok: true, state: result.state, delegationId: result.delegationId };
  }

  function summary() {
    const ordered = [...records.values()].sort((a, b) => a.delegationId.localeCompare(b.delegationId));
    const active = ordered.filter((entry) => ACTIVE_STATE_SET.has(entry.state));
    const lost = ordered.filter((entry) => entry.state === 'lost');
    const terminal = ordered.filter((entry) => isDelegationTerminal(entry.state));
    return {
      runId: boundRunId,
      delegationCount: ordered.length,
      activeDelegations: active.length,
      activeDelegationIds: active.map((entry) => entry.delegationId),
      terminalDelegations: terminal.length,
      lostDelegations: lost.map((entry) => entry.delegationId),
      recoveryFailedDelegations: [...recoveryFailedDelegationIds].sort(),
      errors: [...errors, ...projector.getErrors()],
      valid: errors.length === 0 && projector.isValid(),
      delegations: clone(ordered),
      tree: ordered.map((entry) => ({
        delegationId: entry.delegationId,
        parentDelegationId: entry.parentDelegationId || null,
        childSessionId: entry.childSessionId || null,
        state: entry.state,
      })),
    };
  }

  return { apply, summary, projector };
}

export function createJoinBarrier({ runId, aggregationLeaseMs = 30000 } = {}) {
  const reducer = createProviderNativeDelegationReducer({ runId });
  const leaseDuration = positiveInt(aggregationLeaseMs) ? aggregationLeaseMs : 30000;
  let phase = 'executing';
  let runState = 'running';
  let terminalCandidate = null;
  let reconciliation = { complete: false, missingDelegationIds: [] };
  let aggregation = { generation: 0, claim: null, completed: false };
  let failureReason = '';
  let cancelRequested = false;

  function snapshot() {
    const reduced = reducer.summary();
    const blockers = [];
    if (!reduced.valid) blockers.push({ code: 'delegation_replay_invalid', errors: reduced.errors });
    if (reduced.lostDelegations.length > 0) blockers.push({ code: 'delegation_lost', delegationIds: reduced.lostDelegations });
    if (reduced.recoveryFailedDelegations.length > 0) {
      blockers.push({ code: 'delegation_recovery_failed', delegationIds: reduced.recoveryFailedDelegations });
    }
    if (!reconciliation.complete || reconciliation.missingDelegationIds.length > 0) {
      blockers.push({ code: 'reconciliation_incomplete', missingDelegationIds: reconciliation.missingDelegationIds });
    }
    if (reduced.activeDelegations > 0) blockers.push({ code: 'active_delegations', count: reduced.activeDelegations });
    return {
      runId: trim(runId),
      state: runState,
      phase,
      terminalCandidate: clone(terminalCandidate),
      reconciliation: clone(reconciliation),
      aggregation: clone(aggregation),
      cancelRequested,
      failureReason,
      activeDelegations: reduced.activeDelegations,
      activeDelegationIds: reduced.activeDelegationIds,
      delegationSummary: reduced,
      blockers,
      canComplete: runState === 'completed',
    };
  }

  function refreshPhase() {
    if (runState !== 'running' || phase === 'aggregating') return;
    const reduced = reducer.summary();
    if (!terminalCandidate) {
      phase = 'executing';
      return;
    }
    if (!reduced.valid || reduced.lostDelegations.length > 0 || reduced.recoveryFailedDelegations.length > 0 || !reconciliation.complete || reconciliation.missingDelegationIds.length > 0 || reduced.activeDelegations > 0) {
      phase = 'awaiting_delegations';
    } else {
      phase = 'terminal_candidate';
    }
  }

  function applyDelegationEvent(event) {
    if (runState !== 'running') return failure('run_already_terminal', { state: runState });
    if (aggregation.completed) {
      // A completed aggregation covers a specific delegation evidence prefix.
      // Any later evidence invalidates that result and requires a new generation.
      aggregation = { ...aggregation, claim: null, completed: false };
      phase = 'terminal_candidate';
    }
    const result = reducer.apply(event);
    refreshPhase();
    return result;
  }

  function observeTerminalCandidate(candidate = {}) {
    if (runState !== 'running') return failure('run_already_terminal', { state: runState });
    const outcome = trim(candidate.outcome);
    if (!TERMINAL_CANDIDATE_OUTCOMES.has(outcome)) return failure('invalid_terminal_candidate');
    const next = {
      outcome,
      ...(trim(candidate.resultRef) ? { resultRef: trim(candidate.resultRef) } : {}),
      ...(trim(candidate.reason) ? { reason: trim(candidate.reason) } : {}),
    };
    if (terminalCandidate && JSON.stringify(terminalCandidate) !== JSON.stringify(next)) {
      return failure('terminal_candidate_conflict');
    }
    terminalCandidate = next;
    refreshPhase();
    return { ok: true, phase, candidate: clone(terminalCandidate) };
  }

  function reconcile({ complete = false, missingDelegationIds = [] } = {}) {
    if (runState !== 'running') return failure('run_already_terminal', { state: runState });
    const missing = [...new Set((Array.isArray(missingDelegationIds) ? missingDelegationIds : []).map(trim).filter(Boolean))].sort();
    reconciliation = { complete: complete === true && missing.length === 0, missingDelegationIds: missing };
    refreshPhase();
    return { ok: true, reconciliation: clone(reconciliation), phase };
  }

  function claimAggregation({ claimId, nowMs, leaseMs = leaseDuration } = {}) {
    const now = Number(nowMs);
    if (runState !== 'running') return failure('run_already_terminal', { state: runState });
    if (!positiveInt(now) || !trim(claimId)) return failure('aggregation_claim_requires_time_and_id');
    if (aggregation.completed) return failure('aggregation_already_completed', { generation: aggregation.generation });
    const current = aggregation.claim;
    if (current && now < current.leaseUntil) return failure('aggregation_already_claimed', { generation: aggregation.generation });
    if (phase !== 'terminal_candidate' && !(phase === 'aggregating' && current)) {
      return failure('join_barrier_not_ready', { phase });
    }
    const nextGeneration = aggregation.generation + 1;
    aggregation = {
      generation: nextGeneration,
      claim: { claimId: trim(claimId), leaseUntil: now + (positiveInt(leaseMs) ? leaseMs : leaseDuration) },
      completed: false,
    };
    phase = 'aggregating';
    return { ok: true, generation: nextGeneration, claim: clone(aggregation.claim) };
  }

  function renewAggregationLease({ claimId, generation, nowMs, leaseMs = leaseDuration } = {}) {
    const now = Number(nowMs);
    if (runState !== 'running') return failure('run_already_terminal', { state: runState });
    if (aggregation.completed) return failure('aggregation_already_completed', { generation: aggregation.generation });
    const claim = aggregation.claim;
    if (!claim || aggregation.generation !== generation || claim.claimId !== trim(claimId)) return failure('aggregation_claim_mismatch');
    if (!positiveInt(now) || now >= claim.leaseUntil) return failure('aggregation_lease_expired');
    claim.leaseUntil = now + (positiveInt(leaseMs) ? leaseMs : leaseDuration);
    return { ok: true, claim: clone(claim) };
  }

  function releaseAggregationClaim({ claimId, generation, nowMs } = {}) {
    if (runState !== 'running') return failure('run_already_terminal', { state: runState });
    if (aggregation.completed) return failure('aggregation_already_completed', { generation: aggregation.generation });
    const claim = aggregation.claim;
    if (!claim || aggregation.generation !== generation || claim.claimId !== trim(claimId)) return failure('aggregation_claim_mismatch');
    if (!positiveInt(nowMs) || nowMs >= claim.leaseUntil) return failure('aggregation_lease_expired');
    aggregation = { ...aggregation, claim: null, completed: false };
    phase = 'terminal_candidate';
    return { ok: true, phase };
  }

  function completeAggregation({ claimId, generation, nowMs } = {}) {
    const now = Number(nowMs);
    if (runState !== 'running') return failure('run_already_terminal', { state: runState });
    const claim = aggregation.claim;
    if (aggregation.completed) return failure('duplicate_aggregation_complete', { generation: aggregation.generation });
    if (phase !== 'aggregating') return failure('aggregation_not_active', { phase });
    if (!claim || aggregation.generation !== generation || claim.claimId !== trim(claimId)) return failure('aggregation_claim_mismatch');
    if (!positiveInt(now) || now >= claim.leaseUntil) return failure('aggregation_lease_expired');
    aggregation = { ...aggregation, completed: true };
    phase = 'terminal_candidate';
    return { ok: true, phase, generation };
  }

  function finalize() {
    if (runState !== 'running') return failure('run_already_terminal', { state: runState });
    refreshPhase();
    const reduced = reducer.summary();
    if (!terminalCandidate) return failure('terminal_candidate_missing', { phase });
    if (!reduced.valid) return failure('delegation_replay_invalid', { errors: reduced.errors });
    if (reduced.lostDelegations.length > 0) return failure('delegation_lost', { delegationIds: reduced.lostDelegations });
    if (reduced.recoveryFailedDelegations.length > 0) return failure('delegation_recovery_failed', { delegationIds: reduced.recoveryFailedDelegations });
    if (!reconciliation.complete || reconciliation.missingDelegationIds.length > 0) return failure('reconciliation_incomplete');
    if (reduced.activeDelegations > 0) return failure('active_delegations', { count: reduced.activeDelegations });
    if (!aggregation.completed) return failure('aggregation_incomplete');
    runState = terminalCandidate.outcome === 'cancelled' ? 'cancelled'
      : terminalCandidate.outcome === 'completed' ? 'completed' : 'failed';
    phase = runState;
    failureReason = runState === 'failed' ? (terminalCandidate.reason || 'provider_terminal_failure') : '';
    return { ok: true, state: runState, phase };
  }

  function requestCancel(reason = 'cancel_requested') {
    if (runState !== 'running') return failure('run_already_terminal', { state: runState });
    cancelRequested = true;
    failureReason = trim(reason) || 'cancel_requested';
    return observeTerminalCandidate({ outcome: 'cancelled', reason: failureReason });
  }

  return {
    applyDelegationEvent,
    observeTerminalCandidate,
    reconcile,
    claimAggregation,
    renewAggregationLease,
    releaseAggregationClaim,
    completeAggregation,
    finalize,
    requestCancel,
    snapshot,
    reducer,
  };
}

export function replayJoinBarrier(events = [], options = {}) {
  const barrier = createJoinBarrier(options);
  for (const event of events) barrier.applyDelegationEvent(event);
  return barrier.snapshot();
}
