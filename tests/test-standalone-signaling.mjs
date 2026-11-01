import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { issueSignalJoinToken } from '../lib/browser-connection-grant.mjs';
import { createInstancePublicKeyFingerprint } from '../lib/instance-proof-protocol.mjs';
import { createStandaloneBrowserAuthorizer } from '../p2p/standalone-signaling.mjs';

test('standalone browser signaling retains key, scope, and replay checks', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyId = createInstancePublicKeyFingerprint(publicPem);
  const issuer = 'instance:fixture';
  const scope = { roomId: 'a'.repeat(40), instanceId: 'inst_fixture', clientId: 'client_fixture', connectionId: 'connection_fixture' };
  const allow = createStandaloneBrowserAuthorizer({ issuer, keyId, publicKey: publicPem });
  const token = issueSignalJoinToken({ privateKey, issuer, kid: keyId, ...scope }).token;
  assert.equal(allow({ ...scope, token }), true);
  assert.equal(allow({ ...scope, token }), false, 'replay must be rejected');
  const fresh = issueSignalJoinToken({ privateKey, issuer, kid: keyId, ...scope }).token;
  assert.equal(allow({ ...scope, roomId: 'b'.repeat(40), token: fresh }), false);
  assert.equal(allow({ ...scope }), false);
  assert.throws(() => createStandaloneBrowserAuthorizer({ issuer, keyId: 'wrong', publicKey: publicPem }));
});
