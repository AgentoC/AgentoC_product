import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEMPORARY_CONTROL_CAPABILITIES, TEMPORARY_CONTROL_SESSION_SCOPE,
  authorizeTemporaryControl, createTemporaryControlApprovalActor,
  isTemporaryControlApprovalActor, isTemporaryControlCapabilitySet,
  temporaryControlApprovalAudit } from '../lib/temporary-control-policy.mjs';

const principal = (overrides = {}) => ({
  role: 'temporary', principalKind: 'temporary_device', sessionScope: TEMPORARY_CONTROL_SESSION_SCOPE,
  capabilities: [...TEMPORARY_CONTROL_CAPABILITIES], instanceId: 'inst_abcdefghijklmnopqrstuvwx',
  grantId: 'rtg_abcdefghijklmnopqrstuvwx', expiry: 1_800_000_600_000, ...overrides,
});

test('temporary control maps every privileged workbench action to an explicit capability', () => {
  assert.equal(authorizeTemporaryControl(principal(), 'project.delete').capability, 'project.delete');
  assert.equal(authorizeTemporaryControl(principal(), 'session.create').capability, 'session.create');
  assert.equal(authorizeTemporaryControl(principal(), 'harness.upgrade').capability, 'harness.upgrade');
  assert.equal(authorizeTemporaryControl(principal(), 'provider.oauth').capability, 'provider.oauth');
  assert.equal(authorizeTemporaryControl(principal(), 'approval.resolve').capability, 'approval.resolve');
  assert.equal(authorizeTemporaryControl(principal(), 'approval.privileged.resolve').capability,
    'approval.privileged.resolve');
});

test('a temporary approval actor is request-scoped and separates ordinary from privileged decisions', () => {
  const ordinary = createTemporaryControlApprovalActor(principal(), 'approval.resolve');
  const privileged = createTemporaryControlApprovalActor(principal(), 'approval.privileged.resolve');
  assert.equal(isTemporaryControlApprovalActor(ordinary, 'approval.resolve'), true);
  assert.equal(isTemporaryControlApprovalActor(ordinary, 'approval.privileged.resolve'), false);
  assert.equal(isTemporaryControlApprovalActor({ ...ordinary }, 'approval.resolve'), false,
    'a JSON-shaped request body is never authority');
  assert.deepEqual(temporaryControlApprovalAudit(privileged), {
    source: 'temporary_control', grantId: principal().grantId,
    instanceId: principal().instanceId, expiresAt: principal().expiry,
  });
});

test('an approval actor stops authorizing when its grant deadline passes', () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const actor = createTemporaryControlApprovalActor(principal({ expiry: now + 1000 }), 'approval.resolve');
    assert.equal(isTemporaryControlApprovalActor(actor, 'approval.resolve'), true);
    now += 1000;
    assert.equal(isTemporaryControlApprovalActor(actor, 'approval.resolve'), false);
    assert.equal(temporaryControlApprovalAudit(actor), null);
    assert.throws(() => createTemporaryControlApprovalActor(principal({ expiry: now }), 'approval.resolve'),
      { code: 'temporary_control_denied' });
  } finally {
    Date.now = originalNow;
  }
});

test('share grants, partial grants, unknown operations and non-temporary roles never inherit control', () => {
  const reduced = TEMPORARY_CONTROL_CAPABILITIES.filter((capability) => capability !== 'provider.delete');
  assert.throws(() => authorizeTemporaryControl(principal({ sessionScope: 'created-sessions' }), 'project.read'),
    { code: 'temporary_control_denied' });
  assert.throws(() => authorizeTemporaryControl(principal({ capabilities: reduced }), 'provider.delete'),
    { code: 'temporary_control_denied' });
  assert.throws(() => authorizeTemporaryControl(principal({ role: 'owner' }), 'harness.install'),
    { code: 'temporary_control_denied' });
  assert.throws(() => authorizeTemporaryControl(principal(), 'provider.export-secrets'),
    { code: 'temporary_control_denied' });
});

test('a full control invitation cannot carry partial, duplicate or unknown capabilities', () => {
  assert.equal(isTemporaryControlCapabilitySet([...TEMPORARY_CONTROL_CAPABILITIES].reverse()), true);
  assert.equal(isTemporaryControlCapabilitySet(TEMPORARY_CONTROL_CAPABILITIES.slice(1)), false);
  assert.equal(isTemporaryControlCapabilitySet([...TEMPORARY_CONTROL_CAPABILITIES, 'owner']), false);
  assert.equal(isTemporaryControlCapabilitySet([...TEMPORARY_CONTROL_CAPABILITIES.slice(1), TEMPORARY_CONTROL_CAPABILITIES[0], TEMPORARY_CONTROL_CAPABILITIES[0]]), false);
});
