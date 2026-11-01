import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTemporaryPairingBroker } from '../accounts/temporary-pairing-broker.mjs';
import { createTemporaryClaimCipher } from '../accounts/temporary-pairing-cipher.mjs';
import { verifyTurnBrokerCapability, createTurnBrokerCapabilityClaims } from '../lib/turn-broker-capability.mjs';
import { fixture, initial, id } from './helpers/temporary-turn-fixture.mjs';
const issuer = 'http://127.0.0.1';

test('Accounts HTTP reserves a temporary phone in shared account quota and a real broker enforces its deadline', async (t) => {
  const f = await fixture(t); const phone = await f.enroll(); const reservation = await f.reserve(phone);
  assert.equal(reservation.status, 'COMPLETED'); assert.equal(reservation.lease.deviceKind, 'phone');
  assert.equal(Date.parse(reservation.lease.expiresAt), phone.accessCredential.expires_at);
  const claims = verifyTurnBrokerCapability({ token: reservation.brokerCredential.token, jwks: f.jwks, issuer,
    accountId: reservation.lease.accountId, instanceId: f.identity.instanceId, deviceId: phone.result.deviceId,
    connectionId: reservation.lease.connectionId, nowMs: f.clock() });
  assert.equal(claims.scope, 'turn:mint:temporary'); assert.equal(claims.temporaryGrantId, phone.result.grantId);
  const response = await f.mint(reservation, phone, { ttlMs: 1_800_000 });
  assert.equal(response.credentialScope, 'temporary-device-access');
  assert.ok(Date.parse(response.expiresAt) <= phone.accessCredential.expires_at);
  assert.equal(f.mintCalls.length, 1); assert.equal(f.mintCalls[0].ttlMs, 595_000);
  assert.equal((await f.mint(reservation, phone)).idempotent, true); assert.equal(f.mintCalls.length, 1);
  const state = await f.store.mutate((d) => structuredClone(d));
  assert.equal(state.accountDevices, undefined); assert.equal(state.accountCredentials, undefined);
  assert.equal(state.turnConnectionLeases.length, 1);
});

test('temporary quota counts normal active phones and concurrent temporary claims cannot overbook', async (t) => {
  const f = await fixture(t); const phone = await f.enroll();
  await f.store.mutate((d) => { d.turnConnectionLeases = [{ connectionId: 'existing-owner-connection', accountId: 'acct_temporary_turn',
    instanceId: f.identity.instanceId, deviceId: 'adev_existing', quotaDeviceId: 'adev_existing', deviceKind: 'phone',
    status: 'connected', expiresAt: new Date(initial + 600_000).toISOString() }]; });
  await assert.rejects(f.reserve(phone), { code: 'temporary_broker_turn_quota_exceeded' });
  await f.store.mutate((d) => { d.turnConnectionLeases[0].status = 'released'; });
  const other = await f.enroll();
  const results = await Promise.allSettled([f.reserve(phone), f.reserve(other)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'temporary_broker_turn_quota_exceeded');
});

test('same temporary key can reconnect without double-counting, release does not revoke pairing', async (t) => {
  const f = await fixture(t); const phone = await f.enroll(); const first = await f.reserve(phone);
  const other = await f.enroll(phone.device); const second = await f.reserve(other);
  assert.equal(first.lease.quotaDeviceId, second.lease.quotaDeviceId);
  assert.equal(second.authorization.activePhones, 1); assert.equal(second.authorization.activeComputers, 1);
  assert.equal((await f.client.request('turn-release', phone.claim.invitationId)).released, true);
  assert.equal((await f.reserve(phone)).lease.connectionId, first.lease.connectionId);
});

test('revocation, rebind and expiry release quota and prevent another reservation', async (t) => {
  for (const reason of ['revoke', 'rebind', 'expiry']) {
    const f = await fixture(t); const phone = await f.enroll(); await f.reserve(phone);
    if (reason === 'revoke') await f.app.temporaryBroker.revoke(f.proof('revoke', phone.ticket));
    if (reason === 'rebind') await f.store.mutate((d) => { d.instanceBindings[0].boundAt = new Date(initial + 1).toISOString(); });
    if (reason === 'expiry') f.advance(600_000);
    await assert.rejects(f.reserve(phone), { code: 'temporary_broker_inactive' });
    const leases = await f.store.mutate((d) => structuredClone(d.turnConnectionLeases));
    assert.equal(leases[0].status, 'released');
  }
});

test('reserve requires PC proof, completed device-bound result and no caller quota or deadline overrides', async (t) => {
  const f = await fixture(t); const ticket = await f.host.create();
  await f.app.temporaryBroker.register(f.proof('register', ticket, { envelope: ticket.envelope }));
  await assert.rejects(f.client.request('turn-reserve', ticket.envelope.invitation.invitationId), { code: 'temporary_broker_not_completed' });
  const phone = await f.enroll();
  for (const payload of [{ accountId: 'foreign-account' }, { accessExpiresAt: initial + 900_000 }, { plan: 'pro' }, { deviceId: 'foreign' }]) {
    await assert.rejects(f.client.request('turn-reserve', phone.claim.invitationId, payload), { code: 'temporary_broker_turn_request_invalid' });
  }
  await assert.rejects(f.app.temporaryBroker['turn-reserve'](f.proof('inbox', phone.ticket)), { code: 'temporary_broker_proof_invalid' });
});

test('failed signing does not leak quota and post-signing expiry cannot return a stale capability', async (t) => {
  const f = await fixture(t); const phone = await f.enroll();
  for (const signer of [() => { throw new Error('secret-signer-detail'); }, () => { f.advance(600_000); return 'not-returned'; }]) {
    const broker = createTemporaryPairingBroker({ store: f.store, cipher: createTemporaryClaimCipher(f.keys), clock: f.clock,
      issuer, signTurnBrokerCapability: signer });
    await assert.rejects(broker['turn-reserve'](f.proof('turn-reserve', phone.ticket)), (e) => !e.message.includes('secret-signer-detail'));
    const leases = await f.store.mutate((d) => structuredClone(d.turnConnectionLeases || [])); assert.equal(leases.length, 0);
  }
});

test('temporary mint below 60 seconds stays short and expired capability has no skew grace', async (t) => {
  const f = await fixture(t); const phone = await f.enroll(); f.advance(570_000);
  const reservation = await f.reserve(phone); const response = await f.mint(reservation, phone);
  assert.equal(f.mintCalls[0].ttlMs, 25_000); assert.ok(Date.parse(response.expiresAt) <= initial + 600_000);
  f.advance(30_000);
  // Even a stale client clock cannot obtain the broker's ordinary clock-skew grace.
  await assert.rejects(f.mint(reservation, phone, { clock: () => initial, nowMs: initial }), { code: 'turn_broker_temporary_grant_invalid' });
  assert.equal(f.mintCalls.length, 1);
});

test('late provider response and provider expiry beyond the grant are withheld', async (t) => {
  for (const mode of ['slow', 'long']) {
    const f = await fixture(t); const phone = await f.enroll(); const reservation = await f.reserve(phone);
    f.setMintHook(({ ttlMs }) => {
      if (mode === 'slow') f.advance(6_000);
      return { iceServers: [{ urls: 'turn:fixture.invalid:3478', username: 'fixture', credential: 'fixture' }],
        expiresAt: new Date(mode === 'long' ? initial + 600_001 : initial + ttlMs).toISOString() };
    });
    await assert.rejects(f.mint(reservation, phone), { code: 'turn_broker_temporary_expiring' });
  }
});

test('near-expiry mint fails before contacting provider and capability cannot outlive its original grant', async (t) => {
  const f = await fixture(t); const phone = await f.enroll(); f.advance(595_000);
  const reservation = await f.reserve(phone);
  await assert.rejects(f.mint(reservation, phone), { code: 'turn_broker_temporary_expiring' }); assert.equal(f.mintCalls.length, 0);
  const input = { issuer, accountId: 'acct', instanceId: 'inst', deviceId: 'dev', connectionId: 'conn', nowMs: f.clock(),
    temporaryGrant: { grantId: phone.result.grantId, invitationId: phone.claim.invitationId, accessExpiresAt: f.clock() + 601_000 } };
  await assert.rejects(async () => createTurnBrokerCapabilityClaims(input), { code: 'turn_broker_temporary_grant_invalid' });
});

test('client withholds credentials that expire while the response is being delivered', async (t) => {
  const f = await fixture(t); const phone = await f.enroll(); const reservation = await f.reserve(phone);
  const response = await f.mint(reservation, phone); let attempts = 0;
  await assert.rejects(f.mint(reservation, phone, { fetchImpl: async () => {
    attempts += 1;
    return { ok: true, json: async () => { f.advance(600_000); return response; } };
  } }), { code: 'turn_broker_response_invalid' });
  assert.equal(attempts, 1);
  await assert.rejects(f.mint(reservation, phone), { code: 'turn_broker_temporary_expiring' });
});

test('temporary client rejects static authentication and mismatched returned grants', async (t) => {
  const f = await fixture(t); const phone = await f.enroll(); const reservation = await f.reserve(phone);
  await assert.rejects(f.mint(reservation, phone, { authMode: 'static', brokerToken: 'fixture',
    fetchImpl: () => { assert.fail('static temporary request must not reach network'); } }), { code: 'turn_broker_temporary_grant_invalid' });
  const response = await f.mint(reservation, phone);
  await assert.rejects(f.mint(reservation, phone, { fetchImpl: async () => ({ ok: true,
    json: async () => ({ ...response, temporaryGrantId: id('rtg') }) }) }), { code: 'turn_broker_response_invalid' });
});

test('a corrupted persisted lease identity fails closed instead of releasing another grant', async (t) => {
  const f = await fixture(t); const phone = await f.enroll(); await f.reserve(phone);
  await f.store.mutate((d) => { d.temporaryPairingExchanges[0].turn.grantId = id('rtg'); });
  await assert.rejects(f.reserve(phone), { code: 'temporary_broker_store_invalid' });
});
