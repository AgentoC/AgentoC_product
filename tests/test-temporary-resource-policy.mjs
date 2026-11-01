import assert from 'node:assert/strict';
import { createHash, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from './helpers/temporary-turn-fixture.mjs';
import { temporaryDeviceJwk } from '../lib/temporary-device-access.mjs';
import { TemporaryPairingHost } from '../chat/temporary-pairing-host.mjs';
import { parseSessionCreationRequest, findSessionCreationReplay } from '../chat/session-creation-contract.mjs';
import { rejectUnadaptedTemporaryRequest } from '../chat/temporary-http-isolation.mjs';

const targetUri = 'https://pc.example.test/api/temporary/sessions';
async function authenticate(f, phone, host = f.host) {
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const input = `${enc({ typ: 'dpop+jwt', alg: 'ES256', jwk: temporaryDeviceJwk(phone.claim.devicePublicKey).jwk })}.${enc({
    jti: randomBytes(24).toString('base64url'), htm: 'GET', htu: targetUri, iat: Math.floor(f.clock() / 1000),
    ath: createHash('sha256').update(phone.accessCredential.access_token).digest('base64url') })}`;
  const proof = `${input}.${sign('sha256', Buffer.from(input), { key: phone.device.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  return host.authenticateRequest({ credential: phone.accessCredential, proof, method: 'GET', targetUri });
}
async function owned(f, principal, sessionId = 'session-a') {
  const { principalScope, ...provenance } = await f.host.resourcePolicy.creationIdentity(principal);
  return { id: sessionId, ...provenance,
    creationRequest: parseSessionCreationRequest({ name: 'temporary test', idempotencyKey: 'creation-1' }, null, principalScope) };
}
const denied = { code: 'temporary_resource_denied' };

test('authenticated identities are immutable request-local objects, not cloneable bearer state', async (t) => {
  const f = await fixture(t); const phone = await f.enroll(); const p = await authenticate(f, phone);
  assert.throws(() => { p.role = 'owner'; }, TypeError);
  assert.throws(() => p.capabilities.push('owner'), TypeError);
  assert.equal(await f.host.revalidatePrincipal(p), p);
  await assert.rejects(f.host.revalidatePrincipal(structuredClone(p)), { code: 'temporary_principal_invalid' });
  const reopened = new TemporaryPairingHost({ registry: f.registry, client: f.client, binding: f.host.binding, clock: f.clock });
  await assert.rejects(reopened.revalidatePrincipal(p), { code: 'temporary_principal_invalid' });
  assert.equal((await authenticate(f, phone, reopened)).grantId, p.grantId);
  const before = JSON.parse(await readFile(f.registry.filePath, 'utf8')).records[0].accessProofs.length;
  await f.host.revalidatePrincipal(p); await f.host.revalidatePrincipal(p);
  assert.equal(JSON.parse(await readFile(f.registry.filePath, 'utf8')).records[0].accessProofs.length, before);
});

test('creation identity binds idempotent sessions to the original PC, grant and device', async (t) => {
  const f = await fixture(t); const phone = await f.enroll(); const p = await authenticate(f, phone);
  const session = await owned(f, p); const another = await f.enroll(phone.device);
  const q = await authenticate(f, another); const otherSession = await owned(f, q, 'session-b');
  assert.notEqual(session.creationRequest.principalScope, otherSession.creationRequest.principalScope);
  assert.equal(findSessionCreationReplay([session], otherSession.creationRequest), null);
  assert.equal(findSessionCreationReplay([session], session.creationRequest), session);
  assert.equal((await f.host.resourcePolicy.authorize(p, 'session.read', { session })).sessionId, session.id);
  await assert.rejects(f.host.resourcePolicy.authorize(q, 'session.read', { session }), denied);
  for (const mutate of [
    (s) => { delete s.creationRequest; }, (s) => { s.createdByPrincipalKind = 'owner'; },
    (s) => { s.createdByPrincipalId = q.grantId; }, (s) => { s.creationRequest.principalScope = 'owner'; },
    (s) => { s.creationRequest.key = ''; }, (s) => { s.creationRequest.fingerprint = 'bad'; },
  ]) {
    const altered = structuredClone(session); mutate(altered);
    await assert.rejects(f.host.resourcePolicy.authorize(p, 'session.read', { session: altered }), denied);
  }
});

test('named operations require their own capability and authoritative matching resources', async (t) => {
  const f = await fixture(t); const p = await authenticate(f, await f.enroll()); const session = await owned(f, p);
  const run = { id: 'run-a', sessionId: session.id }, asset = { id: 'fasset_a', sessionId: session.id };
  for (const operation of ['session.read', 'message.prepare', 'message.commit', 'message.receipt', 'upload.create', 'upload.receipt', 'result.read']) {
    assert.equal((await f.host.resourcePolicy.authorize(p, operation, { session })).operation, operation);
  }
  for (const operation of ['run.read', 'run.cancel']) {
    assert.equal((await f.host.resourcePolicy.authorize(p, operation, { session, run })).runId, run.id);
    await assert.rejects(f.host.resourcePolicy.authorize(p, operation, { session }), denied);
    await assert.rejects(f.host.resourcePolicy.authorize(p, operation, { session, run: { ...run, sessionId: 'foreign' } }), denied);
  }
  for (const operation of ['upload.write', 'upload.finalize', 'upload.checkpoint', 'upload.cancel', 'result.download']) {
    assert.equal((await f.host.resourcePolicy.authorize(p, operation, { session, asset })).assetId, asset.id);
    await assert.rejects(f.host.resourcePolicy.authorize(p, operation, { session }), denied);
    await assert.rejects(f.host.resourcePolicy.authorize(p, operation, { session, asset: { ...asset, sessionId: 'foreign' } }), denied);
  }
  for (const operation of ['owner', 'session.delete', 'session.fork', 'task.submit', '__proto__', 'toString', 'GET /api/sessions'])
    await assert.rejects(f.host.resourcePolicy.authorize(p, operation, { session }), denied);
  await assert.rejects(f.host.resourcePolicy.authorize(p, 'session.create', { session }), denied);
  await assert.rejects(f.host.resourcePolicy.authorize(p, 'session.read', { session, folder: '/private' }), denied);
  await assert.rejects(f.host.resourcePolicy.authorize({ ...p, role: 'owner' }, 'session.create'), { code: 'temporary_principal_invalid' });
});

test('create permission does not imply submit, read, cancel, upload or download', async (t) => {
  const f = await fixture(t); const phone = await f.enroll(undefined, { capabilities: ['task.create'] });
  const p = await authenticate(f, phone); const session = await owned(f, p);
  assert.equal((await f.host.resourcePolicy.authorize(p, 'runtime.list')).capability, 'task.create');
  await assert.rejects(f.host.resourcePolicy.authorize(p, 'runtime.list', { session }), denied);
  for (const operation of ['session.read', 'message.prepare', 'message.commit', 'run.cancel', 'upload.create', 'result.download'])
    await assert.rejects(f.host.resourcePolicy.authorize(p, operation, { session }), denied);
});

test('completed authentication cannot survive revoke or account rebinding before a later checkpoint', async (t) => {
  for (const change of ['revoke', 'rebind']) {
    const f = await fixture(t); const phone = await f.enroll(); const p = await authenticate(f, phone); const session = await owned(f, p);
    await f.host.resourcePolicy.authorize(p, 'message.commit', { session });
    if (change === 'revoke') await f.host.revoke(phone.claim.invitationId);
    else f.binding.boundAt = new Date(f.clock() + 1).toISOString();
    await assert.rejects(f.host.resourcePolicy.authorize(p, 'message.commit', { session }), { code: 'temporary_pairing_inactive' });
    // Returning to an earlier binding cannot restore revoked authority.
    f.binding.boundAt = new Date(f.clock()).toISOString();
    await assert.rejects(f.host.revalidatePrincipal(p), { code: 'temporary_pairing_inactive' });
  }
});

test('credential-second deadline and persisted high-water time defeat expiry rollback', async (t) => {
  const f = await fixture(t); f.advance(500); const phone = await f.enroll(); const p = await authenticate(f, phone);
  f.advance(p.expiry - f.clock());
  await assert.rejects(f.host.revalidatePrincipal(p), { code: 'temporary_pairing_inactive' });
  f.advance(-1000);
  await assert.rejects(f.host.revalidatePrincipal(p), { code: 'temporary_pairing_inactive' });
});

test('time advancing during final binding IO cannot return an expired principal', async (t) => {
  const f = await fixture(t); const phone = await f.enroll(); const p = await authenticate(f, phone);
  let calls = 0; f.host.binding = async () => {
    if (++calls === 2) f.advance(p.expiry - f.clock());
    return f.binding;
  };
  await assert.rejects(f.host.revalidatePrincipal(p), { code: 'temporary_pairing_inactive' });
});

test('corrupt private authorization store fails closed after successful authentication', async (t) => {
  const f = await fixture(t); const p = await authenticate(f, await f.enroll());
  await writeFile(f.registry.filePath, '{broken', 'utf8');
  await assert.rejects(f.host.revalidatePrincipal(p));
});

test('unadapted HTTP rejects DPoP even with Owner cookies or bearer, before any fallback handler', async (t) => {
  let fallback = 0;
  const server = createServer((req, res) => {
    if (rejectUnadaptedTemporaryRequest(req, res)) return;
    fallback++; res.writeHead(204); res.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const headers of [{ authorization: 'DPoP secret' }, { authorization: 'dpop secret', cookie: 'owner=old' },
    { authorization: 'Bearer existing', dpop: 'proof' }, { dpop: '' }]) {
    for (const path of ['/api/sessions', '/api/auth/google/token', '/', '/healthz']) {
      const response = await fetch(base + path, { method: 'POST', headers, body: '{}' });
      assert.equal(response.status, 403); assert.match(response.headers.get('cache-control'), /no-store/);
      assert.equal((await response.json()).code, 'temporary_business_not_ready');
    }
  }
  assert.equal(fallback, 0);
  assert.equal((await fetch(base, { headers: { authorization: 'Bearer existing' } })).status, 204);
  assert.equal(fallback, 1);
});
