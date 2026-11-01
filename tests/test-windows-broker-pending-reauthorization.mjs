import assert from 'node:assert/strict';

import { createWindowsBrokerPendingReauthorizer } from '../chat/windows-broker-pending-reauthorization.mjs';

const original = {
  role: 'owner', principalKind: 'trusted_device', principalId: 'paired-1',
  deviceId: 'paired-1', accountId: 'account-1', bindingAuthorityRevision: 'generation-1',
};
let current = { ...original };
let policy = 'allowed';
const reauthorize = createWindowsBrokerPendingReauthorizer({
  authenticateTrustedDeviceToken: async () => current,
  getAuthSession: () => current,
  devicePolicyEngine: { decide: () => ({ kind: policy }) },
});
const bearerRequest = {
  method: 'GET', url: '/api/windows-privileged-broker/requests/pending',
  headers: { authorization: 'Bearer rda_fixture' },
};

assert.deepEqual(await reauthorize(bearerRequest, original), { allowed: true });
current = null;
assert.equal((await reauthorize(bearerRequest, original)).status, 401, 'revoked/expired bearer must renew');
current = { ...original, bindingAuthorityRevision: 'generation-2' };
assert.equal((await reauthorize(bearerRequest, original)).status, 401, 'new binding generation must renew');
current = { ...original };
policy = 'blocked';
assert.equal((await reauthorize(bearerRequest, original)).status, 403, 'device policy denial must fail');
policy = 'allowed';
assert.equal((await reauthorize({ ...bearerRequest, headers: {} }, original)).status, 401);

const cookieOwner = { role: 'owner', principalKind: 'owner', principalId: 'owner-1' };
current = { ...cookieOwner };
assert.deepEqual(await reauthorize({ method: 'GET', headers: {} }, cookieOwner), { allowed: true });
current = null;
assert.equal((await reauthorize({ method: 'GET', headers: {} }, cookieOwner)).status, 401);

const broken = createWindowsBrokerPendingReauthorizer({
  authenticateTrustedDeviceToken: async () => { throw new Error('auth store unavailable'); },
  getAuthSession: () => null,
  devicePolicyEngine: { decide: () => ({ kind: 'allowed' }) },
});
await assert.rejects(broken(bearerRequest, original), /auth store unavailable/);
console.log('Windows Broker pending reauthorization tests passed');
