import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { windowsServiceControlSigningBytes } from '../chat/windows-service-grant.mjs';

const grant = { version: 1, keyId: 'key', brokerInstallationId: 'broker', policyGeneration: 3, requestId: 'request',
  sessionId: 'session', runId: 'run', turnId: 'turn', actionId: 'action', nonce: '0123456789abcdefghijklmn',
  serviceName: '服务 示例 & one', action: 'restart-service', definitionHash: 'a'.repeat(64), authorization: 'owner',
  issuedMs: 1800000000000, expiresMs: 1800000060000 };
const bytes = windowsServiceControlSigningBytes(grant);
assert.equal(createHash('sha256').update(bytes).digest('hex'), '3df9a07c89afdafc1f87f75ba2e2cb7cfcb335153c35a8fb2aa99d0826c6b412');
const keys = generateKeyPairSync('ed25519');
const signature = sign(null, bytes, keys.privateKey);
assert.equal(verify(null, bytes, keys.publicKey, signature), true);
assert.equal(verify(null, windowsServiceControlSigningBytes({ ...grant, serviceName: '其他' }), keys.publicKey, signature), false);
for (const mutation of [{ serviceName: 'bad*' }, { action: 'delete' }, { authorization: 'policy-auto' }, { expiresMs: grant.issuedMs + 60001 }, { extra: true }]) {
  assert.throws(() => windowsServiceControlSigningBytes({ ...grant, ...mutation }), { code: 'SERVICE_CONTROL_GRANT_INVALID' });
}
console.log('windows-service-grant: cross-language signing vector passed');
