#!/usr/bin/env node
import assert from 'assert/strict';

import { normalizeDelegationEvent } from '../chat/delegation-canonical.mjs';
import {
  createJoinBarrier,
  createProviderNativeDelegationReducer,
  replayJoinBarrier,
} from '../chat/provider-native-delegation-barrier.mjs';

function event(fields) {
  return normalizeDelegationEvent({
    provider: 'claude', providerDelegationId: fields.id || 'child_1', runId: 'run_barrier',
    parentSessionId: 'parent_session', childSessionId: fields.child || 'child_session',
    ...fields,
  });
}

function completeAggregation(barrier, claimId = 'claim-1') {
  assert.equal(barrier.reconcile({ complete: true }).ok, true);
  const claim = barrier.claimAggregation({ claimId, nowMs: 100, leaseMs: 100 });
  assert.equal(claim.ok, true, JSON.stringify(claim));
  assert.equal(barrier.completeAggregation({ claimId, generation: claim.generation, nowMs: 150 }).ok, true);
}

// Parent terminal candidate cannot complete while a child is active.
{
  const barrier = createJoinBarrier({ runId: 'run_barrier' });
  assert.equal(barrier.applyDelegationEvent(event({ kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 })).ok, true);
  assert.equal(barrier.observeTerminalCandidate({ outcome: 'completed', resultRef: 'result-1' }).phase, 'awaiting_delegations');
  assert.equal(barrier.finalize().ok, false);
  assert.equal(barrier.finalize().reason, 'reconciliation_incomplete');
  assert.equal(barrier.snapshot().state, 'running', 'legacy run state must remain running');
}

// A terminal child transitions awaiting_delegations back to candidate, then
// aggregation must be claimed and completed exactly once before finalize.
{
  const barrier = createJoinBarrier({ runId: 'run_barrier' });
  barrier.applyDelegationEvent(event({ kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 }));
  barrier.observeTerminalCandidate({ outcome: 'completed', resultRef: 'result-2' });
  barrier.reconcile({ complete: true });
  assert.equal(barrier.snapshot().phase, 'awaiting_delegations');
  barrier.applyDelegationEvent(event({ kind: 'completed', state: 'completed', seq: 2, timestamp: 2 }));
  assert.equal(barrier.snapshot().phase, 'terminal_candidate');
  completeAggregation(barrier);
  assert.equal(barrier.finalize().state, 'completed');
  assert.equal(barrier.snapshot().canComplete, true);
  assert.equal(barrier.completeAggregation({ claimId: 'claim-1', generation: 1, nowMs: 160 }).ok, false);
  assert.equal(barrier.completeAggregation({ claimId: 'claim-1', generation: 1, nowMs: 160 }).reason, 'run_already_terminal');
}

// A completed aggregation generation cannot be reclaimed or released.
{
  const barrier = createJoinBarrier({ runId: 'run_barrier' });
  barrier.observeTerminalCandidate({ outcome: 'completed' });
  barrier.reconcile({ complete: true });
  const claim = barrier.claimAggregation({ claimId: 'claim-once', nowMs: 100, leaseMs: 50 });
  assert.equal(barrier.completeAggregation({ claimId: 'claim-once', generation: claim.generation, nowMs: 120 }).ok, true);
  assert.equal(barrier.claimAggregation({ claimId: 'claim-retry', nowMs: 151 }).reason, 'aggregation_already_completed');
  assert.equal(barrier.releaseAggregationClaim({ claimId: 'claim-once', generation: claim.generation, nowMs: 130 }).reason, 'aggregation_already_completed');
  assert.equal(barrier.renewAggregationLease({ claimId: 'claim-once', generation: claim.generation, nowMs: 130 }).reason, 'aggregation_already_completed');
}

// Duplicate aggregation claim and stale completion are rejected.
{
  const barrier = createJoinBarrier({ runId: 'run_barrier' });
  barrier.observeTerminalCandidate({ outcome: 'completed' });
  barrier.reconcile({ complete: true });
  const first = barrier.claimAggregation({ claimId: 'claim-a', nowMs: 100, leaseMs: 50 });
  assert.equal(barrier.claimAggregation({ claimId: 'claim-b', nowMs: 110 }).reason, 'aggregation_already_claimed');
  assert.equal(barrier.completeAggregation({ claimId: 'claim-a', generation: first.generation, nowMs: 151 }).reason, 'aggregation_lease_expired');
  const reclaimed = barrier.claimAggregation({ claimId: 'claim-b', nowMs: 151, leaseMs: 50 });
  assert.equal(reclaimed.generation, 2);
  assert.equal(barrier.completeAggregation({ claimId: 'claim-a', generation: 1, nowMs: 160 }).reason, 'aggregation_claim_mismatch');
}

// Invalid replay and lost child are fail-closed and cannot become success.
{
  const reducer = createProviderNativeDelegationReducer({ runId: 'run_barrier' });
  reducer.apply(event({ kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 }));
  assert.equal(reducer.apply(event({ kind: 'running', state: 'running', seq: 1, timestamp: 2 })).ok, false);
  assert.equal(reducer.summary().valid, false);

  const barrier = createJoinBarrier({ runId: 'run_barrier' });
  barrier.applyDelegationEvent(event({ kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 }));
  barrier.applyDelegationEvent(event({ kind: 'lost', state: 'lost', seq: 2, timestamp: 2 }));
  barrier.observeTerminalCandidate({ outcome: 'completed' });
  barrier.reconcile({ complete: true });
  assert.equal(barrier.finalize().reason, 'delegation_lost');

  const recoveryFailed = createJoinBarrier({ runId: 'run_barrier' });
  recoveryFailed.applyDelegationEvent(event({ id: 'recovery_failed', child: 'recovery_failed_session', kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 }));
  recoveryFailed.applyDelegationEvent(event({ id: 'recovery_failed', child: 'recovery_failed_session', kind: 'running', state: 'running', seq: 2, timestamp: 2 }));
  recoveryFailed.applyDelegationEvent(event({ id: 'recovery_failed', child: 'recovery_failed_session', kind: 'lost', state: 'lost', seq: 3, timestamp: 3 }));
  recoveryFailed.applyDelegationEvent(event({ id: 'recovery_failed', child: 'recovery_failed_session', kind: 'failed', state: 'failed', seq: 4, timestamp: 4 }));
  recoveryFailed.observeTerminalCandidate({ outcome: 'completed' });
  recoveryFailed.reconcile({ complete: true });
  assert.equal(recoveryFailed.snapshot().delegationSummary.recoveryFailedDelegations.length, 1);
  assert.equal(recoveryFailed.finalize().reason, 'delegation_recovery_failed');
}

// Nested tree and 100-child load are deterministic and active-count safe.
{
  const barrier = createJoinBarrier({ runId: 'run_barrier' });
  const parent = event({ id: 'nested_parent', child: 'nested_parent_session', kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 });
  const nested = event({
    id: 'nested_child', child: 'nested_child_session', parentDelegationId: parent.delegationId,
    kind: 'spawned', state: 'spawned', seq: 1, timestamp: 2,
  });
  assert.equal(barrier.applyDelegationEvent(parent).ok, true);
  assert.equal(barrier.applyDelegationEvent(nested).ok, true);
  const nestedTree = barrier.snapshot().delegationSummary.tree;
  assert.deepEqual(nestedTree.find((entry) => entry.delegationId === parent.delegationId), {
    delegationId: parent.delegationId, parentDelegationId: null, childSessionId: 'nested_parent_session', state: 'spawned',
  });
  assert.deepEqual(nestedTree.find((entry) => entry.delegationId === nested.delegationId), {
    delegationId: nested.delegationId, parentDelegationId: parent.delegationId, childSessionId: 'nested_child_session', state: 'spawned',
  });

  const outOfOrder = event({ id: 'out_of_order', child: 'out_of_order_session', kind: 'spawned', state: 'spawned', seq: 3, timestamp: 3 });
  const outOfOrderReplay = event({ id: 'out_of_order', child: 'out_of_order_session', kind: 'running', state: 'running', seq: 2, timestamp: 4 });
  assert.equal(barrier.applyDelegationEvent(outOfOrder).ok, true);
  assert.equal(barrier.applyDelegationEvent(outOfOrderReplay).ok, false);
  assert.equal(barrier.snapshot().delegationSummary.valid, false);

  const childBeforeParent = createJoinBarrier({ runId: 'run_barrier' });
  assert.equal(childBeforeParent.applyDelegationEvent(nested).ok, false);
  assert.equal(childBeforeParent.snapshot().phase, 'executing');
  assert.equal(childBeforeParent.snapshot().delegationSummary.valid, false);

  const loadBarrier = createJoinBarrier({ runId: 'run_barrier' });
  const events = [];
  for (let index = 0; index < 100; index += 1) {
    events.push(event({ id: `child_${index}`, child: `child_session_${index}`, kind: 'spawned', state: 'spawned', seq: 1, timestamp: index + 1 }));
  }
  for (const item of events.toReversed()) loadBarrier.applyDelegationEvent(item);
  loadBarrier.observeTerminalCandidate({ outcome: 'completed' });
  loadBarrier.reconcile({ complete: true });
  assert.equal(loadBarrier.snapshot().activeDelegations, 100);
  assert.equal(loadBarrier.snapshot().state, 'running');
  assert.equal(loadBarrier.finalize().ok, false);

  const first = replayJoinBarrier(events, { runId: 'run_barrier' });
  for (let index = 0; index < 10; index += 1) {
    const next = replayJoinBarrier(events, { runId: 'run_barrier' });
    assert.deepEqual(next.delegationSummary.tree, first.delegationSummary.tree);
    assert.equal(next.activeDelegations, 100);
    assert.equal(next.phase, 'executing');
  }
}

// Cancellation is still a barrier candidate and cannot bypass active children.
{
  const barrier = createJoinBarrier({ runId: 'run_barrier' });
  barrier.applyDelegationEvent(event({ kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 }));
  assert.equal(barrier.requestCancel('user_cancel').phase, 'awaiting_delegations');
  assert.equal(barrier.finalize().ok, false);
}

// New evidence invalidates a completed aggregation; terminal barriers reject mutation.
{
  const barrier = createJoinBarrier({ runId: 'run_barrier' });
  barrier.observeTerminalCandidate({ outcome: 'completed' });
  barrier.reconcile({ complete: true });
  const claim = barrier.claimAggregation({ claimId: 'claim-stale', nowMs: 100, leaseMs: 100 });
  assert.equal(barrier.completeAggregation({ claimId: 'claim-stale', generation: claim.generation, nowMs: 120 }).ok, true);
  assert.equal(barrier.applyDelegationEvent(event({ id: 'late_child', child: 'late_child_session', kind: 'spawned', state: 'spawned', seq: 1, timestamp: 3 })).ok, true);
  assert.equal(barrier.snapshot().phase, 'awaiting_delegations');
  assert.equal(barrier.finalize().reason, 'active_delegations');

  const terminal = createJoinBarrier({ runId: 'run_barrier' });
  terminal.observeTerminalCandidate({ outcome: 'completed' });
  terminal.reconcile({ complete: true });
  const terminalClaim = terminal.claimAggregation({ claimId: 'claim-terminal', nowMs: 100, leaseMs: 100 });
  terminal.completeAggregation({ claimId: 'claim-terminal', generation: terminalClaim.generation, nowMs: 120 });
  assert.equal(terminal.finalize().state, 'completed');
  assert.equal(terminal.reconcile({ complete: false }).reason, 'run_already_terminal');
  assert.equal(terminal.renewAggregationLease({ claimId: 'claim-terminal', generation: terminalClaim.generation, nowMs: 130 }).reason, 'run_already_terminal');
  assert.equal(terminal.releaseAggregationClaim({ claimId: 'claim-terminal', generation: terminalClaim.generation, nowMs: 130 }).reason, 'run_already_terminal');
  assert.equal(terminal.completeAggregation({ claimId: 'claim-terminal', generation: terminalClaim.generation, nowMs: 130 }).reason, 'run_already_terminal');
  assert.equal(terminal.snapshot().phase, 'completed');
}

// Run IDs are isolated at the barrier boundary.
{
  const barrier = createJoinBarrier({ runId: 'run_barrier' });
  const foreign = event({ id: 'foreign', runId: 'other_run', child: 'foreign_session', kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 });
  assert.equal(barrier.applyDelegationEvent(foreign).reason, 'cross_run_event');
  assert.equal(barrier.snapshot().delegationSummary.valid, false);
}

console.log('test-provider-native-delegation-barrier: ok');
