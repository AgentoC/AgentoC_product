#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const home = mkdtempSync(join(tmpdir(), 'agentoc-account-turn-connections-'));
process.env.HOME = home;
process.env.AGENTOC_CONFIG_DIR = join(home, 'config');
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';

const {
  loadOrCreateInstanceIdentity,
  publicInstanceIdentity,
  signOwnerAuthDeviceProof,
} = await import(pathToFileURL(join(root, 'lib/instance-identity.mjs')).href);
const { createTurnConnectionId } = await import(pathToFileURL(join(root, 'lib/turn-authorization.mjs')).href);
const { createOwnerAuthBroker } = await import(pathToFileURL(join(root, 'accounts/owner-auth-broker.mjs')).href);

const now = Date.parse('2026-08-25T12:00:00.000Z');
const expiresAt = new Date(now + 30 * 60 * 1000).toISOString();
const identity = await loadOrCreateInstanceIdentity({ filePath: join(home, 'computer-a.json') });
const secondIdentity = await loadOrCreateInstanceIdentity({ filePath: join(home, 'computer-b.json') });
const accountId = 'acct_turn_central_1';
const accountDeviceId = 'adev_turn_android_1';
const targetDeviceId = 'rdev_turn_target_1';
const devices = ['phone-1', 'phone-2', 'phone-3'].map((deviceId) => ({
  deviceId,
  instanceId: identity.instanceId,
  accountId,
  deviceKind: 'phone',
  alias: deviceId,
  lastSeenAt: new Date(now).toISOString(),
  unboundAt: '',
  createdAt: new Date(now).toISOString(),
}));
const state = {
  accounts: [{ accountId, provider: 'google', providerSubject: 'subject-central', createdAt: new Date(now).toISOString() }],
  accountEntitlements: [{ accountId, plan: 'free', source: 'test', expiresAt: '' }],
  instanceBindings: [
    { instanceId: identity.instanceId, accountId, provider: 'google', boundAt: new Date(now).toISOString(), revokedAt: '' },
    { instanceId: secondIdentity.instanceId, accountId, provider: 'google', boundAt: new Date(now).toISOString(), revokedAt: '' },
  ],
  devices,
  accountDevices: [{
    deviceId: accountDeviceId,
    accountId,
    alias: 'Pixel',
    platform: 'android',
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    revokedAt: '',
  }],
  accountJoinIntents: [{
    intentId: 'rji_turn_target_1',
    instanceId: identity.instanceId,
    deviceId: targetDeviceId,
    accountId,
    accountDeviceId: '',
    // Rendezvous completion is the terminal state used after the phone has
    // received the target's account-join result.
    status: 'rendezvous_completed',
  }],
  accountJoinGrants: [{
    grantHash: 'grant-hash-turn-target-1',
    accountId,
    instanceId: identity.instanceId,
    intentId: 'rji_turn_target_1',
    deviceId: targetDeviceId,
    accountDeviceId,
    keyFingerprint: 'fingerprint-turn-target-1',
    requestId: 'join-request-turn-target-1',
    createdAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    redeemedAt: new Date(now - 500).toISOString(),
  }],
};
const store = { mutate: async (mutator) => mutator(state) };
const broker = createOwnerAuthBroker({
  store,
  clock: () => now,
  verifyGoogleCredential: async () => ({ providerSubject: 'subject-central' }),
  verifyNativeGoogleCredential: async () => ({ providerSubject: 'subject-central' }),
  resolveAccount: async () => ({ accountId }),
  signAssertion: async () => 'unused',
  signTurnBrokerCapability: async (claims) => `capability.${claims.connectionId}.${claims.jti}`,
});

function request({ actor, deviceId, purpose, instanceId = actor.instanceId }) {
  const connectionId = createTurnConnectionId({ accountId, instanceId, deviceId });
  const issuedAt = new Date(now).toISOString();
  const proof = signOwnerAuthDeviceProof(actor, {
    transactionId: connectionId,
    purpose,
    issuedAt,
    audience: 'agentoc-owner-auth-device',
  });
  return {
    requestId: connectionId,
    accountId,
    deviceId,
    deviceKind: 'phone',
    connectionId,
    expiresAt,
    instance: publicInstanceIdentity(actor),
    issuedAt,
    audience: 'agentoc-owner-auth-device',
    signature: proof.signature,
  };
}

try {
  const first = await broker.reserveTurnConnection(request({ actor: identity, deviceId: 'phone-1', purpose: 'turn-reserve' }));
  assert.equal(first.authorization.authorized, true);
  assert.equal(first.authorization.activePhones, 1);
  assert.equal(first.authorization.activeComputers, 1);

  await assert.rejects(
    () => broker.reserveTurnConnection(request({ actor: identity, deviceId: 'phone-2', purpose: 'turn-reserve' })),
    (error) => error.code === 'turn_connection_quota_exceeded' && error.statusCode === 429,
  );

  const released = await broker.releaseTurnConnection(request({
    actor: identity,
    deviceId: 'phone-1',
    purpose: 'turn-release',
  }));
  assert.equal(released.released, true);
  assert.equal((await broker.releaseTurnConnection(request({
    actor: identity,
    deviceId: 'phone-1',
    purpose: 'turn-release',
  }))).released, false);

  const second = await broker.reserveTurnConnection(request({ actor: identity, deviceId: 'phone-2', purpose: 'turn-reserve' }));
  assert.equal(second.authorization.authorized, true);
  assert.equal(second.authorization.activePhones, 1);
  assert.equal(second.authorization.activeComputers, 1);

  await assert.rejects(
    () => broker.reserveTurnConnection(request({ actor: secondIdentity, deviceId: 'phone-2', purpose: 'turn-reserve' })),
    (error) => error.code === 'turn_connection_quota_exceeded' && error.statusCode === 429,
  );

  await broker.releaseTurnConnection(request({ actor: identity, deviceId: 'phone-2', purpose: 'turn-release' }));
  state.accountJoinIntents.unshift({ ...state.accountJoinIntents[0], intentId: 'rji_stale_without_link' });
  const v2 = await broker.reserveTurnConnection(request({ actor: identity, deviceId: targetDeviceId, purpose: 'turn-reserve' }));
  assert.equal(v2.authorization.authorized, true);
  assert.equal(v2.authorization.activePhones, 1);
  assert.equal(v2.authorization.activeComputers, 1);
  assert.equal(state.turnConnectionLeases.at(-1).quotaDeviceId, accountDeviceId);
  assert.equal(state.accountJoinIntents[0].accountDeviceId, '', 'Do not invent a link for the stale completion');

  // The grant may be pruned after its completion was persisted. Only the
  // genuinely linked completion can authorize this target; never the old row.
  state.accountJoinGrants = [];
  await broker.releaseTurnConnection(request({ actor: identity, deviceId: targetDeviceId, purpose: 'turn-release' }));
  assert.equal((await broker.reserveTurnConnection(request({ actor: identity, deviceId: targetDeviceId, purpose: 'turn-reserve' }))).authorization.authorized, true);
  state.accountDevices[0].revokedAt = new Date(now).toISOString();
  await assert.rejects(broker.reserveTurnConnection(request({ actor: identity, deviceId: targetDeviceId, purpose: 'turn-reserve' })),
    error => error.code === 'turn_connection_device_invalid');
  state.accountDevices[0].revokedAt = '';
  const retainedIntent = state.accountJoinIntents.find(intent => intent.intentId === 'rji_turn_target_1');
  retainedIntent.accountDeviceId = '';
  await assert.rejects(broker.reserveTurnConnection(request({ actor: identity, deviceId: targetDeviceId, purpose: 'turn-reserve' })),
    error => error.code === 'turn_connection_device_invalid');
  retainedIntent.accountDeviceId = accountDeviceId;

  await broker.releaseTurnConnection(request({ actor: identity, deviceId: targetDeviceId, purpose: 'turn-release' }));
  const failingBroker = createOwnerAuthBroker({
    store,
    clock: () => now,
    verifyGoogleCredential: async () => ({ providerSubject: 'subject-central' }),
    verifyNativeGoogleCredential: async () => ({ providerSubject: 'subject-central' }),
    resolveAccount: async () => ({ accountId }),
    signAssertion: async () => 'unused',
    signTurnBrokerCapability: async () => { throw new Error('signer unavailable'); },
  });
  await assert.rejects(
    () => failingBroker.reserveTurnConnection(request({ actor: identity, deviceId: 'phone-3', purpose: 'turn-reserve' })),
    (error) => error.code === 'turn_broker_capability_unavailable' && error.statusCode === 503,
  );
  const failedLease = state.turnConnectionLeases.find((lease) => lease.deviceId === 'phone-3');
  assert.equal(failedLease?.status, 'released');
  assert.equal(failedLease?.releaseReason, 'capability-signing-failed');

  console.log('PASS account TURN connections: quotas, exact target/device links, stale history, retained completion and revocation');
} finally {
  rmSync(home, { recursive: true, force: true });
}
