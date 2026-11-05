import assert from 'node:assert/strict';
import { createDefaultWindowsFactsProvider } from '../chat/semantic-resolver-windows.mjs';

const selected = { id:'Vendor.App', version:'1.2.3', source:'winget', scope:'System', elevation:'ElevationRequired', type:'Msi', nestedType:'Unknown', architecture:'X64', locale:'en-US' };
let calls = 0;
const broker = { inspectService: async () => null, inspectAutoInstall: async () => { calls++; return selected; } };
const createProvider = () => ({ packageFacts: async () => null });
const service = createDefaultWindowsFactsProvider({ platform:'win32', serviceMode:true, createProvider, broker });
const input = { manager:'winget', packages:['Vendor.App'], requestedVersion:'1.2.3', operation:'install' };
const facts = await service.packageFacts(input);
assert.equal(facts?.packages[0].availableVersion, '1.2.3');
assert.deepEqual(facts?.selectedInstaller, selected);
assert.equal(calls, 1);
assert.equal(await service.packageFacts({ ...input, requestedVersion:'' }), null);
assert.equal(await service.packageFacts({ ...input, operation:'remove' }), null);
assert.equal(await service.packageFacts({ ...input, packages:['Other.App'] }), null);
const ordinary = createDefaultWindowsFactsProvider({ platform:'win32', serviceMode:false, createProvider, broker });
assert.equal(await ordinary.packageFacts(input), null);
console.log('Windows service package facts: exact broker inspection and fail-closed cases passed');
