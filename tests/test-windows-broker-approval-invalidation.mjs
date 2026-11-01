import assert from 'node:assert/strict';

import {
  currentWindowsBrokerApprovalRevision,
  publishWindowsBrokerApprovalInvalidation,
  waitForWindowsBrokerApprovalChange,
} from '../chat/windows-broker-approval-invalidation.mjs';

const sent = [];
const broadcast = message => sent.push(message);
const publish = (action, status, requestId = 'qa-request') =>
  publishWindowsBrokerApprovalInvalidation(
    { type: 'result', status, requestId, challenge: { token: 'must-not-leak' } },
    { action, requestId, broadcast },
  );

assert.equal(publish('propose', 'awaiting_device'), true);
assert.equal(publish('decision', 'succeeded'), true);
assert.equal(publish('decision', 'unknown'), true);
assert.equal(publish('status', 'expired', 'qa-expired'), true);
assert.equal(publish('status', 'expired', 'qa-expired'), false);
assert.equal(publishWindowsBrokerApprovalInvalidation({ type: 'result', status: 'expired' },
  { action: 'status', requestId: 'qa-retry', broadcast: () => { throw new Error('socket'); } }), false);
assert.equal(publish('status', 'expired', 'qa-retry'), true);
assert.equal(publish('propose', 'failed'), false);
assert.equal(publish('status', 'awaiting_device'), false);
assert.equal(publishWindowsBrokerApprovalInvalidation({ type: 'error', status: 'expired' },
  { action: 'status', requestId: 'qa-error', broadcast }), false);
assert.deepEqual(sent, Array.from({ length: 5 }, () => ({ type: 'windows_broker_approvals_invalidated' })));

const before = currentWindowsBrokerApprovalRevision();
const waiting = waitForWindowsBrokerApprovalChange('device-a', before, 1_000);
assert.equal(publish('propose', 'awaiting_device'), true);
assert.equal(await waiting, true);
assert.notEqual(currentWindowsBrokerApprovalRevision(), before);
assert.equal(await waitForWindowsBrokerApprovalChange('device-a', before, 1_000), true);

const unchanged = currentWindowsBrokerApprovalRevision();
assert.equal(await waitForWindowsBrokerApprovalChange('device-a', unchanged, 5), false);
const controllers = Array.from({ length: 4 }, () => new AbortController());
const bounded = controllers.map(controller =>
  waitForWindowsBrokerApprovalChange('device-a', unchanged, 1_000, controller.signal));
await assert.rejects(
  waitForWindowsBrokerApprovalChange('device-a', unchanged, 1_000),
  { code: 'BROKER_WAIT_CAPACITY' },
);
controllers.forEach(controller => controller.abort());
assert.deepEqual(await Promise.all(bounded), [false, false, false, false]);
assert.equal(await waitForWindowsBrokerApprovalChange('device-a', '00000000-0000-4000-8000-000000000000:0', 1_000), true);

const globalRevision = currentWindowsBrokerApprovalRevision();
const globalControllers = Array.from({ length: 16 }, () => new AbortController());
const globalWaits = globalControllers.map((controller, index) =>
  waitForWindowsBrokerApprovalChange(`device-${index}`, globalRevision, 1_000, controller.signal));
await assert.rejects(
  waitForWindowsBrokerApprovalChange('device-over-cap', globalRevision, 1_000),
  { code: 'BROKER_WAIT_CAPACITY' },
);
globalControllers[0].abort();
assert.equal(await globalWaits[0], false);
const replacementController = new AbortController();
const replacement = waitForWindowsBrokerApprovalChange(
  'device-replacement', globalRevision, 1_000, replacementController.signal);
globalControllers.slice(1).forEach(controller => controller.abort());
replacementController.abort();
assert.deepEqual(await Promise.all(globalWaits.slice(1)), Array(15).fill(false));
assert.equal(await replacement, false, 'aborting a waiter frees global capacity');
console.log('Windows Broker approval invalidation tests passed');
