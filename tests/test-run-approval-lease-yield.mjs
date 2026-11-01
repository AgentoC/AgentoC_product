#!/usr/bin/env node
import assert from 'assert/strict';
import {
  __hasPendingRunApprovalForTest as hasPendingRunApproval,
  __yieldHarnessRunBudgetForTest as yieldHarnessRunBudget,
  __resumeHarnessRunBudgetForTest as resumeHarnessRunBudget,
  __harnessRunLeasesForTest as harnessRunLeases,
  __yieldedRunLeaseIdsForTest as yieldedRunLeaseIds,
} from '../chat/session-manager.mjs';
import { getAdaptiveConcurrencyBudget } from '../chat/adaptive-concurrency-registry.mjs';

// 1. Test hasPendingRunApproval
assert.equal(hasPendingRunApproval(null), false);
assert.equal(hasPendingRunApproval({ state: 'running' }), false);
assert.equal(hasPendingRunApproval({ state: 'completed' }), false);
assert.equal(hasPendingRunApproval({ state: 'waiting_user' }), true);
assert.equal(hasPendingRunApproval({ state: 'awaiting_approval' }), true);
assert.equal(hasPendingRunApproval({ state: 'running', privilegedBatchPending: { batchId: 'b1' } }), true);
assert.equal(hasPendingRunApproval({
  state: 'running',
  approvedActionPending: { batchId: 'b2' },
  actionPause: { kind: 'approved_action', state: 'waiting_user' },
}), true);
assert.equal(hasPendingRunApproval({
  state: 'running',
  appServerPendingApprovals: [{ approvalId: 'app1', state: 'responded' }],
}), false);
assert.equal(hasPendingRunApproval({
  state: 'running',
  appServerPendingApprovals: [{ approvalId: 'app1', state: 'pending' }],
}), true);

// 2. Test lease yield and resume
const globalBudget = getAdaptiveConcurrencyBudget('harnessRuns');
const runId = 'test_run_approval_yield_1';
const mockRun = { id: runId, tool: 'codex', state: 'running' };

// Simulate lease acquisition
const initialActive = globalBudget.active;
const lease = globalBudget.tryAcquire({ priority: 'interactive' });
assert.ok(lease, 'should acquire lease');
harnessRunLeases.set(runId, { global: lease, provider: null });
assert.equal(globalBudget.active, initialActive + 1);
assert.equal(harnessRunLeases.has(runId), true);

// Run enters approval wait -> Yield lease
const yielded = yieldHarnessRunBudget(runId);
assert.equal(yielded, true);
assert.equal(harnessRunLeases.has(runId), false, 'lease should be removed from active leases');
assert.equal(globalBudget.active, initialActive, 'global active count should decrement');
assert.equal(yieldedRunLeaseIds.has(runId), true, 'runId should be in yielded set');

// User approves -> Resume lease
const resumed = await resumeHarnessRunBudget(mockRun);
assert.equal(resumed, true);
assert.equal(harnessRunLeases.has(runId), true, 'lease should be re-attached');
assert.equal(globalBudget.active, initialActive + 1, 'global active count should increment on adopt');
assert.equal(yieldedRunLeaseIds.has(runId), false, 'runId should be cleared from yielded set');

// Clean up
const cleanupLease = harnessRunLeases.get(runId);
harnessRunLeases.delete(runId);
cleanupLease.global.release({ outcome: 'success' });
assert.equal(globalBudget.active, initialActive);

console.log('test-run-approval-lease-yield: passed');
