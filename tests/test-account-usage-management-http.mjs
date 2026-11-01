import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { handleOwnerAuthRoutes } from '../accounts/owner-auth-routes.mjs';
import { buildAccountSessionMessage, createDevicePublicKeyFingerprint } from '../lib/device-auth-protocol.mjs';

let now = Date.parse('2026-10-24T06:00:00Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();
const accountId = 'acct_usage_owner';
const state = { instanceBindings: [
  { instanceId: 'inst_usage_primary', accountId, deviceAlias: 'Primary', boundAt: iso(), revokedAt: '', instanceKeyFingerprint: 'unchanged-fingerprint' },
  { instanceId: 'inst_usage_binding_only', accountId, deviceAlias: 'Binding only', boundAt: iso(), revokedAt: '' },
  { instanceId: 'inst_usage_other_owner', accountId: 'acct_other', deviceAlias: 'Private', boundAt: iso(), revokedAt: '' },
  { instanceId: 'inst_usage_revoked', accountId, deviceAlias: 'Revoked', boundAt: iso(), revokedAt: iso() },
], devices: [{ deviceId: 'inst_usage_primary', instanceId: 'inst_usage_primary', accountId, deviceKind: 'computer', alias: 'Primary', createdAt: iso() }],
accountEntitlements: [{ accountId, plan: 'plus', source: 'billing-fixture', expiresAt: iso(3600000) }] };
const broker = createOwnerAuthBroker({ clock: () => now, store: { mutate: async (fn) => fn(state) },
  verifyGoogleCredential: async () => ({ sub: 'fixture' }), verifyNativeGoogleCredential: async () => ({ sub: 'fixture' }),
  resolveAccount: async () => ({ accountId }), signAssertion: async () => 'unused' });
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const deviceId = 'adev_usage_phone_primary';
const requestId = 'usage-session-request-00001';
const challenge = await broker.createAccountSessionChallenge({ requestId, device: { deviceId, publicKey, platform: 'android' } });
const signature = sign('sha256', Buffer.from(buildAccountSessionMessage({ transactionId: challenge.transactionId, requestId,
  deviceId, publicKeyFingerprint: createDevicePublicKeyFingerprint(publicKey), nonce: challenge.nonce })), pair.privateKey).toString('base64');
const session = await broker.completeAccountSession({ transactionId: challenge.transactionId, requestId, signature, idToken: 'fixture' });
const token = session.credential.token;
const server = createServer((req, res) => {
  handleOwnerAuthRoutes({ req, res, pathname: req.url, broker, publicBaseUrl: base, allowInsecurePublicBaseUrl: true })
    .then((handled) => { if (!handled) { res.writeHead(404); res.end('{}'); } })
    .catch((error) => { res.writeHead(500); res.end('{}'); console.error(error); });
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}/accounts`;
async function request(path, { method = 'GET', body, credential = token, headers = {} } = {}) {
  const response = await fetch(base + path, { method, headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
    'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
}
const usage = () => request('/v1/owner-auth/account/usage');
const rename = (id, alias, extra = {}) => request(`/v1/owner-auth/account/devices/${id}/rename`, { method: 'POST', body: { alias, ...extra } });
try {
  assert.equal((await request('/v1/owner-auth/account/usage', { credential: '' })).status, 401);
  assert.equal((await request('/v1/owner-auth/account/usage', { credential: '', headers: { Cookie: 'account=acct_usage_owner' } })).status, 401);
  const empty = await usage(); assert.equal(empty.status, 200); assert.match(empty.cache, /no-store/);
  assert.deepEqual(empty.body.subscription, { plan: 'plus', status: 'active', source: 'billing-fixture', expiresAt: iso(3600000) });
  assert.deepEqual(empty.body.turn.limits, { phones: 2, computers: 3 });
  assert.deepEqual(empty.body.turn.used, { phones: 0, computers: 0 });
  assert.deepEqual(empty.body.turn.remaining, { phones: 2, computers: 3 });
  const priorTouch = structuredClone({ credential: state.accountCredentials[0].lastUsedAt, phone: state.accountDevices[0].lastSeenAt });
  now += 1_000;
  assert.equal((await usage()).status, 200);
  assert.deepEqual({ credential: state.accountCredentials[0].lastUsedAt, phone: state.accountDevices[0].lastSeenAt }, priorTouch,
    'Frequent reads must not turn into a full activity publication');
  const lease = (id, phone, pc, status = 'reserved', offset = 60000) => ({ connectionId: id, accountId, instanceId: pc,
    deviceId: `rdev_${id}`, quotaDeviceId: phone, deviceKind: 'phone', status, expiresAt: iso(offset) });
  state.turnConnectionLeases = [lease('one', deviceId, 'inst_usage_primary'),
    lease('two', deviceId, 'inst_usage_binding_only', 'connected'),
    lease('three', 'adev_usage_phone_second', 'inst_usage_primary'),
    lease('released', 'unused', 'unused', 'released'), lease('expired', 'unused', 'unused', 'reserved', 0),
    { ...lease('foreign', 'foreign', 'foreign'), accountId: 'acct_other' }];
  const before = structuredClone(state.turnConnectionLeases);
  const live = await usage();
  assert.deepEqual(live.body.turn.used, { phones: 2, computers: 2 }, 'One phone linked to two computers uses one phone slot');
  assert.deepEqual(live.body.turn.remaining, { phones: 0, computers: 1 });
  assert.deepEqual(live.body.turn.connections, { active: 3, reserved: 2, connected: 1 });
  assert.deepEqual(state.turnConnectionLeases, before, 'Query must not mint, renew or release leases');
  const spoofed = await request('/v1/owner-auth/account/usage?accountId=acct_other');
  assert.deepEqual(spoofed.body, live.body, 'Query cannot select another account');
  assert.doesNotMatch(JSON.stringify(live.body), /rac_|rdev_|adev_|inst_|tokenHash|credential|publicKey/);
  state.accountEntitlements[0].expiresAt = iso();
  const expired = await usage();
  assert.equal(expired.body.subscription.plan, 'free'); assert.equal(expired.body.subscription.status, 'expired');
  assert.equal(expired.body.subscription.source, 'default');
  assert.deepEqual(expired.body.turn.remaining, { phones: 0, computers: 0 });
  assert.deepEqual(expired.body.turn.overLimit, { phones: true, computers: true });
  assert.deepEqual(state.turnConnectionLeases, before, 'Expired subscription reporting must not erase active authority');
  const trust = structuredClone(state.instanceBindings[0]);
  assert.equal((await rename('inst_usage_primary', ' Office\r\n电脑 ')).status, 200);
  assert.equal(state.instanceBindings[0].deviceAlias, 'Office 电脑');
  assert.equal(state.devices[0].alias, 'Office 电脑');
  assert.deepEqual({ ...state.instanceBindings[0], deviceAlias: trust.deviceAlias }, trust, 'Rename must not change binding or trust');
  assert.equal((await rename('inst_usage_binding_only', 'Laptop')).status, 200);
  assert.equal((await rename(deviceId, '荣耀手机')).status, 200);
  assert.equal(state.accountDevices[0].alias, '荣耀手机');
  const ownBefore = structuredClone(state.instanceBindings);
  assert.equal((await rename('inst_usage_other_owner', 'Hijack', { accountId: 'acct_other' })).status, 404);
  assert.deepEqual(state.instanceBindings, ownBefore);
  assert.equal((await rename('inst_usage_revoked', 'Revive')).status, 409);
  assert.equal((await rename('inst_usage_primary', '  ')).status, 400);
  assert.equal((await rename('inst_usage_primary', 'bad\u0000name')).status, 400);
  assert.equal((await rename('inst_usage_primary', 'Office 电脑')).status, 200, 'Setting the same alias is idempotent');
  const directory = await broker.listAccountDirectoryDevices({ credential: token });
  assert.equal(directory.devices.find((d) => d.deviceId === 'inst_usage_binding_only').alias, 'Laptop');
  now += 60_000;
  assert.equal((await usage()).status, 200);
  assert.equal(Date.parse(state.accountCredentials[0].lastUsedAt), now, 'Presence still updates after its bounded interval');
  assert.equal(Date.parse(state.accountDevices[0].lastSeenAt), now);
  state.accountCredentials[0].revokedAt = iso();
  assert.equal((await usage()).status, 401);
  assert.equal((await rename('inst_usage_primary', 'Denied')).status, 401);
  state.accountCredentials[0].revokedAt = '';
  state.accountDevices[0].revokedAt = iso();
  assert.equal((await usage()).status, 403);
  assert.equal((await rename('inst_usage_primary', 'Denied')).status, 403);
  assert.equal(state.accountCredentials[0].tokenHash, createHash('sha256').update(token).digest('hex'));
  console.log('PASS account usage/management HTTP: authenticated account isolation, live endpoint quota deduplication, expiry, no-store/no secrets, phone/computer rename, trust preservation and revocation');
} finally { await new Promise((done) => server.close(done)); }
