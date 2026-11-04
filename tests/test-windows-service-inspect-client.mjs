import assert from 'node:assert/strict';
import { createWindowsPrivilegedBrokerClient } from '../chat/windows-privileged-broker.mjs';
import { createWindowsRuntimeFactsProvider, revalidateWindowsServiceFacts } from '../chat/windows-runtime-facts-provider.mjs';

let calls = 0;
const client = createWindowsPrivilegedBrokerClient({ platform: 'win32', pipeExchange: async ({ pipe, request }) => {
  calls++;
  assert.equal(pipe, 'request');
  assert.deepEqual(request, { version: 2, type: 'service.inspect', serviceInspect: { serviceName: 'Example Service' } });
  return { version: 2, type: 'service_inspection', serviceFacts: { serviceName: 'Example Service', definitionHash: 'a'.repeat(64) } };
} });
assert.deepEqual(await client.inspectService({ serviceName: 'Example Service' }), { platform: 'win32', manager: 'windows-service',
  serviceName: 'Example Service', exists: true, definitionHash: 'a'.repeat(64) });
await assert.rejects(client.inspectService({ serviceName: 'bad*' }), { code: 'BROKER_REQUEST_INVALID' });
assert.equal(calls, 1);
const provider = createWindowsRuntimeFactsProvider({ platform: 'win32', serviceInspector: client.inspectService,
  execFile: async () => { throw new Error('service control must use broker facts'); } });
assert.equal((await provider.serviceFacts({ serviceName: 'Example Service', action: 'restart-service' })).definitionHash, 'a'.repeat(64));
assert.equal((await revalidateWindowsServiceFacts({ serviceName: 'Example Service', action: 'restart-service', definitionHash: 'a'.repeat(64) }, { provider })).ok, true);
assert.equal(calls, 3);
const mismatch = createWindowsPrivilegedBrokerClient({ platform: 'win32', pipeExchange: async () => ({ version: 2,
  type: 'service_inspection', serviceFacts: { serviceName: 'Different', definitionHash: 'a'.repeat(64) } }) });
await assert.rejects(mismatch.inspectService({ serviceName: 'Example Service' }), { code: 'BROKER_RESPONSE_INVALID' });
console.log('windows-service-inspect-client: request and response binding passed');
