import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { buildApprovedAction } from '../chat/approved-actions.mjs';
import { prepareApprovedActionSemanticProjection } from '../chat/approved-action-semantic.mjs';
import { windowsServiceControlSigningBytes } from '../chat/windows-service-grant.mjs';
import { submitOrResumeWindowsServiceProposal, windowsServiceRequestIds } from '../chat/windows-service-proposal.mjs';

const context = { sessionId: 'session', runId: 'run', turnId: 'turn', requestKey: 'request', platform: 'win32',
  cwd: 'D:\\work', projectRoot: 'D:\\work', home: 'D:\\home' };
const action = buildApprovedAction({ command: 'Restart-Service Example' }, context);
const projection = await prepareApprovedActionSemanticProjection({ action, trustedContext: context,
  resolverOptions: { windowsFactsProvider: { name: 'fixture', async serviceFacts({ serviceName }) {
    return { platform: 'win32', manager: 'windows-service', serviceName, exists: true, definitionHash: 'a'.repeat(64) };
  } } } });
const keys = generateKeyPairSync('ed25519');
const { requestId } = windowsServiceRequestIds(action);
let submitted = null, count = 0, active = 0;
const client = {
  status: async id => submitted
    ? { type: 'result', requestId: id, status: 'awaiting_device', serviceControl: submitted.grant }
    : { type: 'result', requestId: id, code: 'REQUEST_NOT_FOUND' },
  health: async () => ({ type: 'health', serviceControlReady: true, autoInstallKeyId: 'key', installationId: 'broker', policyGeneration: 3 }),
  proposeServiceControl: async request => {
    count++; submitted = request;
    assert.equal(verify(null, windowsServiceControlSigningBytes(request.grant), keys.publicKey, Buffer.from(request.signature, 'base64url')), true);
    return { type: 'result', requestId, status: 'awaiting_device' };
  },
};
const options = { action, projection, riskMode: 'recommended', authenticatedPrincipalKind: 'owner',
  client, kid: 'key', privateKey: keys.privateKey, assertActive: async () => { active++; }, now: 1800000000000 };
assert.equal((await submitOrResumeWindowsServiceProposal(options)).duplicate, false);
assert.equal(submitted.grant.serviceName, 'Example');
assert.equal(submitted.grant.action, 'restart-service');
assert.equal((await submitOrResumeWindowsServiceProposal(options)).duplicate, true);
assert.equal(count, 1); assert.equal(active, 1);
const mismatchClient = { ...client, status: async id => ({ type: 'result', requestId: id, status: 'awaiting_device',
  serviceControl: { ...submitted.grant, definitionHash: 'b'.repeat(64) } }) };
await assert.rejects(submitOrResumeWindowsServiceProposal({ ...options, client: mismatchClient }), { code: 'SERVICE_BINDING_CONFLICT' });
for (const riskMode of ['full-auto', 'conservative-auto']) {
  await assert.rejects(submitOrResumeWindowsServiceProposal({ ...options, riskMode }), { code: 'SERVICE_PROFILE_DENIED' });
}
await assert.rejects(submitOrResumeWindowsServiceProposal({ ...options, authenticatedPrincipalKind: 'run_capability' }), { code: 'SERVICE_PROFILE_DENIED' });
const altered = structuredClone(projection);
altered.decisions[0].operation.target.serviceName = 'Other';
await assert.rejects(submitOrResumeWindowsServiceProposal({ ...options, projection: altered }), { code: 'SERVICE_PROJECTION_INVALID' });
const changed = { ...action, requestKey: 'different' };
await assert.rejects(submitOrResumeWindowsServiceProposal({ ...options, action: changed }), { code: 'SERVICE_PROJECTION_INVALID' });
const ambiguousClient = { ...client, status: async id => ({ type: 'result', requestId: id, code: 'REQUEST_NOT_FOUND' }),
  proposeServiceControl: async () => { throw new Error('connection lost'); } };
await assert.rejects(submitOrResumeWindowsServiceProposal({ ...options, client: ambiguousClient }), { code: 'SERVICE_PROPOSAL_OUTCOME_UNKNOWN', requestId });
const unavailableClient = { ...ambiguousClient, health: async () => ({ type: 'health', serviceControlReady: false }) };
await assert.rejects(submitOrResumeWindowsServiceProposal({ ...options, client: unavailableClient }), { code: 'SERVICE_BROKER_NOT_READY' });
let lookups = 0;
const racingClient = { ...client, status: async id => ++lookups === 1
  ? { type: 'result', requestId: id, code: 'REQUEST_NOT_FOUND' }
  : { type: 'result', requestId: id, status: 'awaiting_device', serviceControl: submitted.grant },
  proposeServiceControl: async () => { throw Object.assign(new Error('race'), { code: 'REQUEST_ID_CONFLICT' }); } };
assert.equal((await submitOrResumeWindowsServiceProposal({ ...options, client: racingClient })).duplicate, true);
console.log('windows-service-proposal: ok');
