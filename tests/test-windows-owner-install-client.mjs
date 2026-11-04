import assert from 'node:assert/strict';
import { createWindowsPrivilegedBrokerClient } from '../chat/windows-privileged-broker.mjs';

const identity = { instanceId: 'inst_0123456789abcdef0123456789abcdef', ownerSid: 'S-1-5-21-1-2-3-1001' };
const requests = [];
const client = createWindowsPrivilegedBrokerClient({ platform: 'win32', pipeExchange: async ({ pipe, request }) => {
  requests.push({ pipe, request });
  if (request.type === 'owner_install.identity') return { version: 2, type: 'owner_install_identity', ownerIdentity: identity };
  return { version: 2, type: 'result', requestId: request.ownerInstall.requestId, status: 'executing' };
} });
assert.deepEqual(await client.ownerInstallIdentity(), identity);
const now = Date.now();
const grant = { version: 1, keyId: identity.instanceId, brokerInstallationId: 'broker', policyGeneration: 1, ...identity,
  requestId: 'request', sessionId: 'session', runId: 'run', turnId: 'turn', actionId: 'action', nonce: 'abcdefghijklmnopqrstuvwx',
  packageId: 'Vendor.App', packageVersion: '1.2.3', source: 'winget', installScope: 'user', issuedMs: now, expiresMs: now + 60000 };
assert.equal((await client.executeOwnerInstall({ grant, signature: 'a'.repeat(86) })).status, 'executing');
assert.equal(requests[1].pipe, 'request');
await assert.rejects(client.executeOwnerInstall({ grant: { ...grant, ownerSid: 'S-1-5-18' }, signature: 'a'.repeat(86) }), { code: 'BROKER_REQUEST_INVALID' });
const bad = createWindowsPrivilegedBrokerClient({ platform: 'win32', pipeExchange: async () => ({ type: 'owner_install_identity', ownerIdentity: { ...identity, extra: 'x' } }) });
await assert.rejects(bad.ownerInstallIdentity(), { code: 'BROKER_RESPONSE_INVALID' });
console.log('windows-owner-install-client: identity and grant validation passed');
