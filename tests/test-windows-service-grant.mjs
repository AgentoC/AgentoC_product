import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { windowsServiceControlSigningBytes, windowsServiceOwnerSigningBytes, windowsServiceReviewSigningBytes } from '../chat/windows-service-grant.mjs';
import { createWindowsPrivilegedBrokerClient } from '../chat/windows-privileged-broker.mjs';

const grant = { version: 1, keyId: 'key', brokerInstallationId: 'broker', policyGeneration: 3, requestId: 'request',
  sessionId: 'session', runId: 'run', turnId: 'turn', actionId: 'action', nonce: '0123456789abcdefghijklmn',
  serviceName: '服务 示例 & one', action: 'restart-service', definitionHash: 'a'.repeat(64), authorization: 'owner',
  issuedMs: 1800000000000, expiresMs: 1800000060000 };
const bytes = windowsServiceControlSigningBytes(grant);
assert.equal(createHash('sha256').update(bytes).digest('hex'), '3df9a07c89afdafc1f87f75ba2e2cb7cfcb335153c35a8fb2aa99d0826c6b412');
assert.equal(createHash('sha256').update(windowsServiceOwnerSigningBytes(grant)).digest('hex'), 'e0cb3610783fd33fdc745e5059474811b3dac76415ef91a283cf110df0af9bf1');
assert.equal(createHash('sha256').update(windowsServiceReviewSigningBytes(grant)).digest('hex'), 'd98b2c6f1b2def03d2fffb8eb9d8375dd031ffc42f5a7ae4d861470ae7a026b9');
const keys = generateKeyPairSync('ed25519');
const signature = sign(null, bytes, keys.privateKey);
const ownerKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const deviceId = 'a'.repeat(64);
const deviceSignature = sign('sha256', windowsServiceOwnerSigningBytes(grant), ownerKeys.privateKey).toString('base64');
assert.equal(verify('sha256', windowsServiceOwnerSigningBytes(grant), ownerKeys.publicKey, Buffer.from(deviceSignature, 'base64')), true);
assert.equal(verify(null, bytes, keys.publicKey, signature), true);
assert.equal(verify(null, windowsServiceControlSigningBytes({ ...grant, serviceName: '其他' }), keys.publicKey, signature), false);
for (const mutation of [{ serviceName: 'bad*' }, { serviceName: 'bad\ud800' }, { action: 'delete' }, { authorization: 'policy-auto' }, { expiresMs: grant.issuedMs + 600001 }, { extra: true }]) {
  assert.throws(() => windowsServiceControlSigningBytes({ ...grant, ...mutation }), { code: 'SERVICE_CONTROL_GRANT_INVALID' });
}
let calls = 0;
const client = createWindowsPrivilegedBrokerClient({ platform: 'win32', pipeExchange: async ({ pipe, request }) => {
  calls++; assert.equal(pipe, 'request');
  if (request.type === 'service.pending') return { version: 2, type: 'service_pending', servicePending: [{ grant, brokerPublicKey: 'fixture', brokerSignature: 'eA==' }], hasMore: false };
  assert.deepEqual(request.serviceControl, grant);
  if (request.type === 'service.propose') return { version: 2, type: 'result', requestId: grant.requestId, status: 'awaiting_device' };
  if (request.type === 'service.review') return { version: 2, type: 'service_review', serviceControl: grant, brokerPublicKey: 'fixture', brokerSignature: 'eA==' };
  assert.equal(request.type, 'service.execute');
  return { type: 'result', version: 2, requestId: grant.requestId, status: 'executing', code: 'EXECUTION_STARTED' };
} });
assert.equal((await client.proposeServiceControl({ grant, signature: signature.toString('base64url') })).status, 'awaiting_device');
assert.equal((await client.pendingServiceControls({ deviceId })).items[0].grant.serviceName, grant.serviceName);
assert.equal((await client.reviewServiceControl({ grant, signature: signature.toString('base64url'), deviceId })).type, 'service_review');
assert.equal((await client.executeServiceControl({ grant, signature: signature.toString('base64url'), deviceId, deviceSignature })).status, 'executing');
await assert.rejects(client.executeServiceControl({ grant: { ...grant, action: 'delete' }, signature: signature.toString('base64url'), deviceId, deviceSignature }), { code: 'BROKER_REQUEST_INVALID' });
await assert.rejects(client.executeServiceControl({ grant, signature: signature.toString('base64url') }), { code: 'BROKER_REQUEST_INVALID' });
assert.equal(calls, 4);
console.log('windows-service-grant: cross-language signing vector passed');
