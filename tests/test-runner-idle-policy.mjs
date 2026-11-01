#!/usr/bin/env node
import assert from 'assert/strict';
import {
  hasPendingApprovedAction,
  hasPendingRuntimeApproval,
  hasPendingPrivilegedBatch,
} from '../chat/runner-idle-policy.mjs';

assert.equal(hasPendingRuntimeApproval(null), false);
assert.equal(hasPendingRuntimeApproval({ pendingApprovals: new Map() }), false);
assert.equal(hasPendingRuntimeApproval({
  pendingApprovals: new Map([['approval-1', { state: 'pending' }]]),
}), true);
assert.equal(hasPendingRuntimeApproval({
  pendingApprovals: new Map([['approval-1', { state: 'responded' }]]),
}), false);

// P1c-4: privileged-batch idle exemption. Explicitly disabled sessions remain
// a pure no-op; only an ON session with accumulated ops exempts the idle timer.
assert.equal(hasPendingPrivilegedBatch(null), false);
assert.equal(hasPendingPrivilegedBatch({}), false);
// privilegedMode OFF with ops present → still no-op (never touches non-privileged runs).
assert.equal(hasPendingPrivilegedBatch({ privilegedMode: false, privilegedTurnOps: [{ opId: 'op-1' }] }), false);
// privilegedMode ON but no accumulated ops → not paused.
assert.equal(hasPendingPrivilegedBatch({ privilegedMode: true, privilegedTurnOps: [] }), false);
assert.equal(hasPendingPrivilegedBatch({ privilegedMode: true }), false);
// privilegedMode ON with ≥1 accumulated op → held batch, exempt from idle-kill.
assert.equal(hasPendingPrivilegedBatch({ privilegedMode: true, privilegedTurnOps: [{ opId: 'op-1' }] }), true);
// defensive: non-array privilegedTurnOps → false.
assert.equal(hasPendingPrivilegedBatch({ privilegedMode: true, privilegedTurnOps: 'nope' }), false);

// Phase 2 — post-drain waiting_user pause: the quiescence-debounce drain empties
// the accumulator but sets privilegedBatchOpen. That long pause (user resolving
// popups, can be minutes) MUST stay exempt even with zero accumulated ops —
// without this branch the idle-kill timer would fire and murder the run mid-popup.
assert.equal(hasPendingPrivilegedBatch({ privilegedMode: true, privilegedTurnOps: [], privilegedBatchOpen: true }), true);
assert.equal(hasPendingPrivilegedBatch({ privilegedMode: true, privilegedBatchOpen: true }), true);
// privilegedBatchOpen is only honored inside privileged mode (defensive: a stale
// open flag after the mode flips off must not exempt a non-privileged run).
assert.equal(hasPendingPrivilegedBatch({ privilegedMode: false, privilegedBatchOpen: true }), false);
// privilegedMode ON, explicit privilegedBatchOpen false, no ops → not paused.
assert.equal(hasPendingPrivilegedBatch({ privilegedMode: true, privilegedTurnOps: [], privilegedBatchOpen: false }), false);

assert.equal(hasPendingApprovedAction(null), false);
assert.equal(hasPendingApprovedAction({ approvedActionPending: { batchId: 'aab_1' } }), false);
assert.equal(hasPendingApprovedAction({
  approvedActionPending: { batchId: 'aab_1' },
  actionPause: { kind: 'approved_action', state: 'waiting_user' },
}), true);
assert.equal(hasPendingApprovedAction({
  approvedActionPending: { batchId: 'aab_1' },
  actionPause: { kind: 'approved_action', state: 'resolved' },
}), false);
assert.equal(hasPendingApprovedAction({
  approvedActionPending: { batchId: 'aab_1', expiresAt: new Date(0).toISOString() },
  actionPause: { kind: 'approved_action', state: 'waiting_user' },
}), false);

console.log('test-runner-idle-policy: ok');
