import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { fixture, id } from './helpers/temporary-turn-fixture.mjs';
import { TemporaryConnectionService } from '../chat/temporary-connection-service.mjs';
import { TemporaryPairingHost } from '../chat/temporary-pairing-host.mjs';
import { TemporaryPairingRegistry } from '../chat/temporary-pairing-registry.mjs';
import { createTemporaryPairingClient } from '../lib/temporary-pairing-client.mjs';
import { buildTemporaryClaimMessage, temporaryInvitationDigest } from '../lib/temporary-pairing-protocol.mjs';
import { buildTemporaryBrokerMessage, verifyTemporaryCompletion } from '../lib/temporary-pairing-broker-protocol.mjs';
import { verifyTemporaryConnectionDelivery } from '../lib/temporary-connection-delivery.mjs';
import { createTemporaryPairingBroker } from '../accounts/temporary-pairing-broker.mjs';
import { createTemporaryClaimCipher } from '../accounts/temporary-pairing-cipher.mjs';
import { buildTemporaryConnectionContract } from '../lib/temporary-connection-contract.mjs';

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const signalingEndpoint = 'https://signal.example.test/signal';
async function setup(t, { algorithm = 'p256', offset = 0, businessReady = false } = {}) {
  const f = await fixture(t); f.advance(offset);
  let starts = 0; const agents = []; let startHook;
  const attach = (host) => {
    const s = new TemporaryConnectionService({ host, brokerUrl: f.turnUrl, signalingEndpoint, clock: f.clock,
      startCarrier: async () => {
        starts += 1; const done = deferred(); const agent = { ready: Promise.resolve(), done: done.promise,
          stop: () => done.resolve(), temporaryBusinessReady: businessReady };
        agents.push(agent); if (startHook) await startHook(); return agent;
      } });
    host.connectionService = s; return host;
  };
  attach(f.host); t.after(() => { f.host.close(); for (const a of agents) a.stop(); });
  const ticket = await f.host.create(); await f.host.tick();
  const device = algorithm === 'p256' ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) : generateKeyPairSync('ed25519');
  const digest = algorithm === 'p256' ? 'sha256' : null;
  const claim = { instanceId: f.identity.instanceId, invitationId: ticket.envelope.invitation.invitationId,
    invitationDigest: temporaryInvitationDigest(ticket.envelope.invitation), requestId: id('rtr'), token: ticket.token,
    devicePublicKey: device.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  claim.signature = sign(digest, Buffer.from(buildTemporaryClaimMessage(claim)), device.privateKey).toString('base64url');
  const http = async (action, input, expected = 200) => {
    const res = await fetch(`${f.client.baseUrl}/v1/temporary-pairing/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const body = await res.json(); assert.equal(res.status, expected, body.code); return body;
  };
  const proof = (action, payload = {}, changes = {}, key = device.privateKey) => {
    const input = { instanceId: claim.instanceId, invitationId: claim.invitationId, requestId: claim.requestId,
      issuedAt: f.clock(), nonce: id('rtn'), payload, ...changes };
    input.signature = sign(digest, Buffer.from(buildTemporaryBrokerMessage(action, input)), key).toString('base64url'); return input;
  };
  await http('claim', claim); await f.host.tick(); f.advance(4_000); await f.host.tick();
  const completion = (await http('result', proof('result'))).completion;
  const result = verifyTemporaryCompletion(completion, { envelope: ticket.envelope, claim, expectedInstance: f.identity, now: f.clock() });
  const connectionRequestId = id('rtr');
  const facts = () => ({ envelope: ticket.envelope, grant: { ...result, devicePublicKey: claim.devicePublicKey },
    credential: completion.payload.accessCredential, expectedInstance: f.identity, connectionRequestId, now: f.clock() });
  const connect = () => http('connect', proof('connect', { connectionRequestId }));
  const read = (expected = 200) => http('connection-result', proof('connection-result', { connectionRequestId }), expected);
  const tick = async () => { f.advance(4_000); return f.host.tick(); };
  return { f, ticket, claim, device, result, connectionRequestId, facts, http, proof, connect, read, tick, attach,
    get starts() { return starts; }, setStartHook: (fn) => { startHook = fn; } };
}

test('phone requests and retrieves a PC-signed encrypted-at-rest connection over real Accounts HTTP', async (t) => {
  for (const algorithm of ['p256', 'ed25519']) {
    const s = await setup(t, { algorithm });
    assert.equal((await s.connect()).connectionStatus, 'PENDING');
    assert.equal((await s.read()).connection, null);
    assert.equal((await s.tick()).handled, true);
    const response = await s.read();
    const payload = verifyTemporaryConnectionDelivery(response.connection, s.facts());
    assert.equal(payload.carrierReady, true); assert.equal(payload.businessAccessReady, false);
    assert.equal(s.starts, 1); assert.equal(s.f.mintCalls.length, 1);
    const snapshot = await s.f.store.mutate((d) => structuredClone(d));
    assert.ok(snapshot.temporaryPairingExchanges[0].connection.delivery.sealed.data);
    assert.equal(JSON.stringify(snapshot).includes(payload.p2p.secret), false);
    assert.equal(JSON.stringify(snapshot).includes(payload.bootstrap.turn.iceServers[0].password), false);
    const inbox = await s.f.client.request('inbox', s.claim.invitationId);
    assert.equal(JSON.stringify(inbox).includes(payload.p2p.secret), false);
    assert.equal((await s.http('result', s.proof('result'))).connection, undefined);
    s.f.host.close();
  }
});

test('device proof, action, nonce and the original connection request identity are enforced', async (t) => {
  const s = await setup(t); const p = s.proof('connect', { connectionRequestId: s.connectionRequestId });
  await s.http('connect', p); await s.http('connect', p, 409);
  await s.http('connection-result', s.proof('connect', { connectionRequestId: s.connectionRequestId }), 401);
  const foreign = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await s.http('connection-result', s.proof('connection-result', { connectionRequestId: s.connectionRequestId }, {}, foreign.privateKey), 401);
  await s.http('connect', s.proof('connect', { connectionRequestId: id('rtr') }), 409);
  await s.http('connection-result', s.proof('connection-result', { connectionRequestId: id('rtr') }), 404);
  await s.http('connect', s.proof('connect', { connectionRequestId: s.connectionRequestId, accountId: 'foreign' }), 401);
  await s.http('connect', { ...s.proof('connect', { connectionRequestId: s.connectionRequestId }), unsignedExtra: 'not-signed' }, 401);
  assert.equal((await s.connect()).connectionStatus, 'PENDING'); assert.equal(s.starts, 0);
});

test('lost publish response reconciles from the broker without a second carrier or mint', async (t) => {
  const s = await setup(t); await s.connect(); let lost = false; let publications = 0;
  s.f.host.client = createTemporaryPairingClient({ baseUrl: s.f.client.baseUrl, identity: s.f.identity, clock: s.f.clock, allowInsecure: true,
    fetchImpl: async (url, options) => {
      const response = await fetch(url, options);
      if (url.endsWith('/connection-publish')) {
        publications += 1;
        if (!lost) { lost = true; await response.text(); throw new Error('fixture response loss'); }
      }
      return response;
    } });
  assert.equal((await s.tick()).handled, false);
  const first = verifyTemporaryConnectionDelivery((await s.read()).connection, s.facts());
  assert.equal((await s.tick()).handled, true);
  assert.deepEqual(verifyTemporaryConnectionDelivery((await s.read()).connection, s.facts()), first);
  assert.equal(publications, 1); assert.equal(s.starts, 1); assert.equal(s.f.mintCalls.length, 1);
});

test('first signed delivery can report business access only after the carrier adapter is ready', async t => {
  const s = await setup(t, { businessReady: true });
  await s.connect(); await s.tick();
  const signed = (await s.read()).connection;
  const verified = verifyTemporaryConnectionDelivery(signed, s.facts());
  assert.equal(verified.carrierReady, true);
  assert.equal(verified.businessAccessReady, true);
  assert.equal(s.starts, 1);
  await s.http('connection-publish', s.f.proof('connection-publish', s.ticket,
    { ...signed.payload, businessAccessReady: false }), 409);
});

test('cold PC reopening restarts the same room while retaining the original signed delivery', async (t) => {
  const s = await setup(t); await s.connect(); await s.tick(); const original = (await s.read()).connection;
  s.f.host.close();
  const registry = new TemporaryPairingRegistry({ filePath: s.f.registry.filePath, identity: s.f.identity, clock: s.f.clock });
  s.f.host = s.attach(new TemporaryPairingHost({ registry, client: s.f.client, binding: async () => s.f.binding, clock: s.f.clock }));
  assert.equal((await s.tick()).handled, true);
  assert.deepEqual((await s.read()).connection, original); assert.equal(s.starts, 2); assert.equal(s.f.mintCalls.length, 1);
});

test('revoke and credential-second expiry erase encrypted delivery and forbid phone recovery', async (t) => {
  for (const mode of ['revoke', 'expiry']) {
    const s = await setup(t, { offset: 999 }); await s.connect(); await s.tick();
    if (mode === 'revoke') { await s.f.host.revoke(s.claim.invitationId); await s.tick(); }
    else s.f.advance(s.facts().credential.expires_at - s.f.clock());
    assert.equal((await s.read(410)).code, 'temporary_broker_inactive');
    const record = await s.f.store.mutate((d) => structuredClone(d.temporaryPairingExchanges[0]));
    assert.equal(record.connection, null); assert.equal(record.completion, null);
    if (mode === 'expiry') { s.f.advance(-1_000); await s.read(410); }
    s.f.host.close();
  }
});

test('revoke while host startup waits cannot publish a late connection', async (t) => {
  const s = await setup(t); await s.connect(); const entered = deferred(); const release = deferred();
  s.setStartHook(async () => { entered.resolve(); await release.promise; });
  const work = s.tick(); await entered.promise;
  await s.f.host.revoke(s.claim.invitationId); release.resolve();
  assert.equal((await work).handled, false);
  assert.equal((await s.f.store.mutate((d) => d.temporaryPairingExchanges[0])).connection.delivery, null);
  await s.tick(); await s.read(410);
});

test('cipher key rotation can be repaired only by republishing the same PC-signed payload', async (t) => {
  const s = await setup(t); await s.connect(); await s.tick(); const old = (await s.read()).connection;
  const broker = createTemporaryPairingBroker({ store: s.f.store, clock: s.f.clock,
    cipher: createTemporaryClaimCipher({ activeKeyId: 'next', keys: { next: randomBytes(32).toString('base64') } }) });
  await assert.rejects(broker['connection-result'](s.proof('connection-result', { connectionRequestId: s.connectionRequestId })),
    { code: 'temporary_broker_connection_unavailable' });
  assert.equal((await broker.inbox(s.f.proof('inbox', s.ticket))).connectionRequest.published, false);
  await broker['connection-publish'](s.f.proof('connection-publish', s.ticket, old.payload));
  const restored = await broker['connection-result'](s.proof('connection-result', { connectionRequestId: s.connectionRequestId }));
  assert.deepEqual(verifyTemporaryConnectionDelivery(restored.connection, s.facts()), old.payload);
});

test('signed replacement, wrong room secret and corrupted ciphertext cannot replace a saved connection', async (t) => {
  const s = await setup(t); await s.connect(); await s.tick(); const original = (await s.read()).connection;
  const replacement = structuredClone(original.payload);
  replacement.bootstrap = buildTemporaryConnectionContract({ identity: s.f.identity, ...s.facts(),
    turn: { ...replacement.bootstrap.turn, expiresAt: new Date(Date.parse(replacement.bootstrap.expiresAt) - 1_000).toISOString() },
    authorization: replacement.bootstrap.turnAuthorization, p2p: replacement.p2p, issuedAtMs: s.f.clock() });
  await s.http('connection-publish', s.f.proof('connection-publish', s.ticket, replacement), 409);
  await s.http('connection-publish', s.f.proof('connection-publish', s.ticket,
    { ...original.payload, p2p: { ...original.payload.p2p, secret: '0'.repeat(64) } }), 401);
  await s.http('connection-publish', s.f.proof('connection-publish', s.ticket,
    { ...original.payload, businessAccessReady: true }), 409);
  await s.f.store.mutate((d) => { const sealed = d.temporaryPairingExchanges[0].connection.delivery.sealed;
    sealed.tag = (sealed.tag[0] === 'A' ? 'B' : 'A') + sealed.tag.slice(1); });
  await s.read(503);
});

test('phone verification rejects a broker-swapped connection request or PC delivery signature', async (t) => {
  const s = await setup(t); await s.connect(); await s.tick(); const original = (await s.read()).connection;
  assert.throws(() => verifyTemporaryConnectionDelivery(original, { ...s.facts(), connectionRequestId: id('rtr') }));
  const swapped = structuredClone(original); swapped.payload.connectionRequestId = id('rtr');
  assert.throws(() => verifyTemporaryConnectionDelivery(swapped, { ...s.facts(), connectionRequestId: swapped.payload.connectionRequestId }));
});
