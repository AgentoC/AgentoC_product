import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createOwnerAuthBroker } from '../accounts/owner-auth-broker.mjs';
import { buildAccountSessionMessage, buildDesktopAccountSessionAuthorization, createDevicePublicKeyFingerprint } from '../lib/device-auth-protocol.mjs';
import { createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { createDemoAccountPolicy, createDemoAccountAuth } from '../accounts/demo-credentials.mjs';

const desktop = generateKeyPairSync('ed25519');
const phone = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKey = desktop.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const phoneKey = phone.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const fingerprint = createDevicePublicKeyFingerprint(phoneKey);
let now = Date.now();
let state = { instanceBindings: [{ instanceId: 'inst_desktop_authorizer', accountId: 'acct_desktop_owner',
  instancePublicKey: publicKey, instanceKeyFingerprint: createInstancePublicKeyFingerprint(publicKey), revokedAt: '' }] };
const store = { mutate: async (fn) => {
  const draft = structuredClone(state); const result = await fn(draft); state = draft; return result;
} };
const broker = createOwnerAuthBroker({ store, clock: () => now,
verifyGoogleCredential: async () => { throw new Error('Google verification must not run'); },
resolveAccount: async () => { throw new Error('Google account resolution must not run'); },
signAssertion: async () => 'unused' });

async function request(deviceId = 'adev_new_phone') {
  const requestId = `request_desktop_session_${state.accountSessionChallenges?.length || 0}`;
  const challenge = await broker.createAccountSessionChallenge({ requestId, device: { deviceId, publicKey: phoneKey, platform: 'android' } });
  const material = { transactionId: challenge.transactionId, requestId, deviceId, publicKeyFingerprint: fingerprint, nonce: challenge.nonce };
  const proof = { instanceId: state.instanceBindings[0].instanceId, accountId: state.instanceBindings[0].accountId, issuedAt: new Date(now).toISOString() };
  proof.signature = sign(null, Buffer.from(buildDesktopAccountSessionAuthorization({ ...material, ...proof })), desktop.privateKey).toString('base64url');
  return { transactionId: challenge.transactionId, requestId,
    signature: sign('sha256', Buffer.from(buildAccountSessionMessage(material)), phone.privateKey).toString('base64'), desktopProof: proof };
}

const input = await request();
await assert.rejects(broker.completeAccountSession(input), { code: 'owner_auth_account_session_invalid' }, 'ordinary Google completion cannot reinterpret desktop proofs');
for (const mutate of [
  (x) => { x.desktopProof.accountId = 'acct_attacker'; },
  (x) => { x.desktopProof.instanceId = 'inst_unknown'; },
  (x) => { x.desktopProof.signature = 'tampered'; },
  (x) => { x.desktopProof.issuedAt = new Date(now - 31_000).toISOString(); },
]) {
  const bad = structuredClone(input); mutate(bad);
  await assert.rejects(broker.completeDelegatedAccountSession(bad), { code: 'owner_auth_desktop_authorization_invalid' });
}
await assert.rejects(broker.completeDelegatedAccountSession({ ...input, signature: 'tampered' }), { code: 'owner_auth_account_session_signature_invalid' });
const other = await request('adev_other_phone');
await assert.rejects(broker.completeDelegatedAccountSession({ ...other, desktopProof: input.desktopProof }), { code: 'owner_auth_desktop_authorization_invalid' }, 'approval is bound to the exact target challenge and phone');
const session = await broker.completeDelegatedAccountSession(input);
assert.equal(session.accountId, 'acct_desktop_owner');
assert.equal(session.deviceId, 'adev_new_phone');
assert.equal(session.keyFingerprint, fingerprint);
assert.match(session.credential.token, /^rac_/);
assert.equal(JSON.stringify(state).includes(session.credential.token), false, 'only the new phone receives its credential');
await assert.rejects(broker.completeDelegatedAccountSession(input), { code: 'owner_auth_account_session_consumed' });
state.instanceBindings[0].revokedAt = new Date(now).toISOString();
await assert.rejects(broker.completeDelegatedAccountSession(other), { code: 'owner_auth_desktop_authorization_invalid' });
state.instanceBindings[0].revokedAt = '';
await assert.rejects(broker.completeDelegatedAccountSession(await request('adev_demo_wrong_namespace')),
  { code: 'owner_auth_account_device_namespace_mismatch' }, 'QR hint cannot put Google in the demo enrollment namespace');
const policy = await createDemoAccountPolicy({ username: 'qr-review-fixture', password: 'fixture-password-only-long', instanceId: state.instanceBindings[0].instanceId });
state.instanceBindings[0].accountId = policy.accountId;
state.accounts = [{ accountId: policy.accountId, provider: 'demo', providerSubject: 'qr-review-fixture' }];
const demoBroker = createOwnerAuthBroker({ store, clock: () => now, demoAccountAuth: createDemoAccountAuth({ ...policy, accessMode: 'full' }),
  verifyGoogleCredential: async () => { throw new Error('No Google login'); }, resolveAccount: async () => { throw new Error('No Google resolution'); }, signAssertion: async () => 'unused' });
await assert.rejects(demoBroker.completeDelegatedAccountSession(await request('adev_wrong_normal_namespace')),
  { code: 'owner_auth_account_device_namespace_mismatch' }, 'legacy or tampered QR cannot reserve the Google enrollment id for demo');
assert.equal(state.accountDevices.some(device => device.deviceId === 'adev_wrong_normal_namespace'), false);
const demoSession = await demoBroker.completeDelegatedAccountSession(await request('adev_demo_correct_namespace'));
assert.equal(demoSession.accountId, policy.accountId);
assert.equal(demoSession.demoAccessMode, 'full');
console.log('test-desktop-account-session-authorization: passed');
