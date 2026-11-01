import assert from 'node:assert/strict';
import { handleAccountPairingOwnerRoutes } from '../chat/router-account-pairing-routes.mjs';
const id = 'rpinv_route_test_0001'; let calls = 0;
async function invoke(role, principalKind, method = 'GET', suffix = '') {
  let result;
  const handled = await handleAccountPairingOwnerRoutes({ req: { method }, res: { setHeader() {} },
    pathname: `/api/device-pairing/account-invitations/${id}${suffix}`, authSession: { role, principalKind },
    getService: async () => ({ status, approve: status, revoke: status }),
    writeJson: (_, statusCode, body) => { result = { statusCode, body }; } });
  async function status(givenId) { calls++; assert.equal(givenId, id);
    return { instanceId: 'inst_routes_0001', invitationId: id, status: 'CLAIMED', expiresAt: Date.now(),
      claim: { nonce: 'private_nonce', deviceSignature: 'private_proof', publicKeyFingerprint: 'a'.repeat(64) } }; }
  assert.equal(handled, true); return result;
}
for (const [role, principal] of [['owner', 'temporary'], ['owner', 'trusted_device'], ['device', null], [null, null]]) {
  assert.equal((await invoke(role, principal)).statusCode, 403);
}
assert.equal(calls, 0);
for (const [method, suffix] of [['GET', ''], ['POST', '/approve'], ['POST', '/revoke']]) {
  const result = await invoke('owner', 'owner', method, suffix);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.invitation.phoneFingerprint, 'a'.repeat(64));
  assert.doesNotMatch(JSON.stringify(result), /private_nonce|private_proof/);
}
assert.equal((await invoke('owner', null, 'POST')).statusCode, 405);
assert.equal((await invoke('owner', null, 'GET', '/approve')).statusCode, 405);
console.log('test-account-pairing-owner-routes: passed');
