// Server-side creation of a single owner-reviewed service request. No provider
// supplied target or decision may bypass the semantic projection.
import { createHash, randomBytes, sign } from 'node:crypto';
import { isApprovedActionSemanticProjectionIntact } from './approved-action-semantic.mjs';
import { computeSemanticManifestHash } from './semantic-operation.mjs';
import { windowsServiceControlSigningBytes } from './windows-service-grant.mjs';
import { publishWindowsBrokerApprovalInvalidation } from './windows-broker-approval-invalidation.mjs';

const id = /^[A-Za-z0-9._:-]{1,128}$/;
const statuses = new Set(['awaiting_device', 'executing', 'succeeded', 'failed', 'denied', 'expired', 'unknown']);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

function boundService(action, projection) {
  const projected = { ...action, semanticProjection: projection, semanticManifestHash: projection?.semanticManifestHash };
  if (!action || !projection || !isApprovedActionSemanticProjectionIntact(projected) || projection.decision !== 'ASK' ||
      projection.unknowns?.length || projection.decisions?.length !== 1) fail('SERVICE_PROJECTION_INVALID', 'Service operation is not a complete reviewable projection');
  const entry = projection.decisions[0], op = entry.operation, target = op?.target, snapshot = target?.resourceSnapshot;
  if (entry.decision !== 'ASK' || entry.unknowns?.length || !op || entry.operationId !== op.operationId ||
      entry.operationManifestHash !== computeSemanticManifestHash(op) || op.scope?.computed !== true ||
      op.analysis?.effectsComplete !== true || op.analysis?.unknowns?.length ||
      op.primaryAction !== 'service.control' || op.executionClass !== 'host' || JSON.stringify(op.effects) !== JSON.stringify(['process.execute']) ||
      target?.kind !== 'windows_service' || target.platform !== 'win32' || target.manager !== 'windows-service' || target.exact !== true ||
      !['start-service', 'stop-service', 'restart-service'].includes(target.action) || snapshot?.serviceName !== target.serviceName ||
      !/^[a-f0-9]{64}$/.test(snapshot?.definitionHash || '') || entry.resolverSnapshotIdentity !== snapshot.identity ||
      ['sessionId', 'runId', 'turnId', 'requestKey'].some(key => !action[key] || op.requestBinding?.[key] !== action[key])) {
    fail('SERVICE_PROJECTION_INVALID', 'Service operation binding or snapshot is invalid');
  }
  return { serviceName: target.serviceName, action: target.action, definitionHash: snapshot.definitionHash };
}

export function windowsServiceRequestIds(action) {
  const binding = ['sessionId', 'runId', 'turnId', 'requestKey'].map(key => action?.[key]);
  if (binding.some(value => typeof value !== 'string' || !value.trim())) fail('SERVICE_BINDING_INVALID', 'A stable run binding is required');
  const digest = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
  return { requestId: `svc_${digest}`, actionId: `action_${digest}` };
}

// A failed or timed-out proposal is ambiguous. A retry reads the original
// durable request ID before creating any new nonce, and matches every target.
export async function submitOrResumeWindowsServiceProposal({ action, projection, riskMode, authenticatedPrincipalKind, client,
  kid, privateKey, assertActive, now = Date.now() } = {}) {
  if (!['safe', 'recommended'].includes(riskMode) || authenticatedPrincipalKind !== 'owner') {
    fail('SERVICE_PROFILE_DENIED', 'This profile cannot request an owner service approval');
  }
  const target = boundService(action, projection);
  const { requestId, actionId } = windowsServiceRequestIds(action);
  if (!client || typeof client.status !== 'function' || typeof client.health !== 'function' || typeof client.proposeServiceControl !== 'function' ||
      typeof assertActive !== 'function' || !privateKey || !id.test(kid || '') || !Number.isSafeInteger(now) || now < 1) {
    fail('SERVICE_PROPOSAL_UNAVAILABLE', 'Service proposal dependencies are unavailable');
  }
  const matches = result => {
    const grant = result?.serviceControl;
    return result?.type === 'result' && result.requestId === requestId && statuses.has(result.status) && grant &&
      grant.requestId === requestId && grant.actionId === actionId && grant.sessionId === action.sessionId &&
      grant.runId === action.runId && grant.turnId === action.turnId && grant.authorization === 'owner' &&
      grant.serviceName === target.serviceName && grant.action === target.action && grant.definitionHash === target.definitionHash;
  };
  const resume = result => {
    if (!matches(result)) fail('SERVICE_BINDING_CONFLICT', 'Existing service request does not match this operation');
    return { ...result, duplicate: true };
  };
  let existing = await client.status(requestId);
  if (!(existing?.type === 'result' && existing.requestId === requestId && existing.code === 'REQUEST_NOT_FOUND' && !existing.status)) return resume(existing);
  const health = await client.health();
  if (health?.type !== 'health' || health.serviceControlReady !== true || health.autoInstallKeyId !== kid ||
      !id.test(health.installationId || '') || !Number.isSafeInteger(health.policyGeneration) || health.policyGeneration < 1) {
    fail('SERVICE_BROKER_NOT_READY', 'Windows service broker is unavailable');
  }
  const grant = { version: 1, keyId: kid, brokerInstallationId: health.installationId, policyGeneration: health.policyGeneration,
    requestId, sessionId: action.sessionId, runId: action.runId, turnId: action.turnId, actionId,
    nonce: randomBytes(24).toString('base64url'), ...target, authorization: 'owner', issuedMs: now, expiresMs: now + 600_000 };
  const signature = sign(null, windowsServiceControlSigningBytes(grant), privateKey).toString('base64url');
  await assertActive();
  try {
    const result = await client.proposeServiceControl({ grant, signature });
    publishWindowsBrokerApprovalInvalidation(result, { action: 'propose', requestId });
    return { ...result, duplicate: false };
  } catch (cause) {
    if (cause?.code === 'REQUEST_ID_CONFLICT') {
      try { existing = await client.status(requestId); } catch { /* ambiguous; caller must query the same ID */ }
      if (matches(existing)) return resume(existing);
    }
    throw Object.assign(new Error('Windows service proposal outcome is unknown; query the original request'), {
      code: 'SERVICE_PROPOSAL_OUTCOME_UNKNOWN', requestId, cause,
    });
  }
}
