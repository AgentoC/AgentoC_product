// Server-side creation of a single owner-reviewed service request. No provider
// supplied target or decision may bypass the semantic projection.
import { createHash, randomBytes, sign } from 'node:crypto';
import { isApprovedActionSemanticProjectionIntact } from './approved-action-semantic.mjs';
import { computeSemanticManifestHash } from './semantic-operation.mjs';
import { compileSemanticOperations } from './semantic-compiler.mjs';
import { windowsServiceControlSigningBytes } from './windows-service-grant.mjs';
import { publishWindowsBrokerApprovalInvalidation } from './windows-broker-approval-invalidation.mjs';

const id = /^[A-Za-z0-9._:-]{1,128}$/;
const statuses = new Set(['awaiting_device', 'executing', 'succeeded', 'failed', 'denied', 'expired', 'unknown']);
const ownerRunAuthorized = (kind, verified) => kind === 'owner' || (kind === 'trusted_device' && verified === true);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function assertBrokerStatusAvailable(result) {
  if (result?.type === 'error') fail(result.code || 'SERVICE_STATUS_UNAVAILABLE', 'Windows service status is temporarily unavailable');
}

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

function matchesServiceResult(result, action, target, requestId, actionId) {
  const grant = result?.serviceControl;
  return result?.type === 'result' && result.requestId === requestId && statuses.has(result.status) && grant &&
    grant.requestId === requestId && grant.actionId === actionId && grant.sessionId === action.sessionId &&
    grant.runId === action.runId && grant.turnId === action.turnId && grant.authorization === 'owner' &&
    grant.serviceName === target.serviceName && grant.action === target.action && grant.definitionHash === target.definitionHash;
}

// Status is read-only and never retries a submission or consumes a grant.
export async function queryWindowsServiceProposal({ action, projection, authenticatedPrincipalKind, verifiedOwnerDevice, client } = {}) {
  if (!ownerRunAuthorized(authenticatedPrincipalKind, verifiedOwnerDevice)) fail('SERVICE_PROFILE_DENIED', 'Service status requires the owner run');
  const target = boundService(action, projection);
  const { requestId, actionId } = windowsServiceRequestIds(action);
  if (!client || typeof client.status !== 'function') fail('SERVICE_PROPOSAL_UNAVAILABLE', 'Service broker is unavailable');
  const result = await client.status(requestId);
  assertBrokerStatusAvailable(result);
  if (result?.type === 'result' && result.requestId === requestId && result.code === 'REQUEST_NOT_FOUND' && !result.status) {
    return { requestId, status: 'unknown', code: 'SERVICE_REQUEST_NOT_FOUND' };
  }
  if (!matchesServiceResult(result, action, target, requestId, actionId)) {
    fail('SERVICE_BINDING_CONFLICT', 'Existing service request does not match this operation');
  }
  return { requestId, status: result.status, code: result.code || '' };
}

// Reconstruct the literal operation from the original command for status-only
// requests. Do not re-resolve its service definition: it may have changed after
// the operation completed, but the original outcome must remain queryable.
export async function queryWindowsServiceProposalFromCommand({ action, trustedContext, authenticatedPrincipalKind, verifiedOwnerDevice, client } = {}) {
  if (!ownerRunAuthorized(authenticatedPrincipalKind, verifiedOwnerDevice)) fail('SERVICE_PROFILE_DENIED', 'Service status requires the owner run');
  const { requestId, actionId } = windowsServiceRequestIds(action);
  const compiled = compileSemanticOperations({
    request: { sessionId: action.sessionId, runId: action.runId, turnId: action.turnId, requestKey: action.requestKey,
      rawCommand: action.canonicalCommand, executionClass: action.executionClass, tool: 'approved-action', commandForm: 'argv' },
    trustedContext: { ...trustedContext, platform: 'win32' },
  });
  const op = compiled?.operations?.length === 1 ? compiled.operations[0] : null;
  if (!op || op.primaryAction !== 'service.control' || op.executionClass !== 'host' ||
      op.target?.kind !== 'windows_service' || op.target?.platform !== 'win32' || op.target?.exact !== true ||
      op.analysis?.effectsComplete !== true || op.analysis?.unknowns?.length) return null;
  if (!client || typeof client.status !== 'function') fail('SERVICE_PROPOSAL_UNAVAILABLE', 'Service broker is unavailable');
  const result = await client.status(requestId);
  assertBrokerStatusAvailable(result);
  if (result?.type === 'result' && result.requestId === requestId && result.code === 'REQUEST_NOT_FOUND' && !result.status) {
    return { requestId, status: 'unknown', code: 'SERVICE_REQUEST_NOT_FOUND' };
  }
  const grant = result?.serviceControl;
  if (!grant || !matchesServiceResult(result, action, { serviceName: op.target.serviceName, action: op.target.action,
    definitionHash: grant.definitionHash }, requestId, actionId)) fail('SERVICE_BINDING_CONFLICT', 'Existing service request does not match this operation');
  try { windowsServiceControlSigningBytes(grant); } catch { fail('SERVICE_BINDING_CONFLICT', 'Existing service request is invalid'); }
  return { requestId, status: result.status, code: result.code || '' };
}

// Observe only the original broker record. A cancelled wait or broken
// transport cannot establish whether an operation has executed.
export async function waitWindowsServiceProposal({ action, projection, authenticatedPrincipalKind, verifiedOwnerDevice, client, signal,
  timeoutMs = 10 * 60_000 + 10_000, intervalMs = 2_000, monotonicNow = () => performance.now(),
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)), assertActive, onStatus } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0 ||
      typeof monotonicNow !== 'function' || typeof delay !== 'function') {
    fail('SERVICE_STATUS_INVALID', 'Invalid service status wait');
  }
  const { requestId } = windowsServiceRequestIds(action);
  const deadline = monotonicNow() + timeoutMs;
  const unknown = () => ({ requestId, status: 'unknown', code: 'SERVICE_OUTCOME_UNKNOWN' });
  let previousStatus = '';
  let transientFailures = 0;
  const retryable = new Set(['RATE_LIMITED', 'BROKER_PIPE_TIMEOUT', 'BROKER_PIPE_UNAVAILABLE',
    'BROKER_STORAGE_UNAVAILABLE', 'SERVICE_STATUS_UNAVAILABLE']);
  while (!signal?.aborted && monotonicNow() < deadline) {
    let result;
    try { result = await queryWindowsServiceProposal({ action, projection, authenticatedPrincipalKind, verifiedOwnerDevice, client }); }
    catch (error) {
      if (['SERVICE_BINDING_CONFLICT', 'SERVICE_PROJECTION_INVALID', 'SERVICE_PROFILE_DENIED'].includes(error?.code)) throw error;
      if (!retryable.has(error?.code)) return unknown();
      if (typeof assertActive === 'function') {
        try { await assertActive(); } catch { return unknown(); }
      }
      const remaining = deadline - monotonicNow();
      if (remaining <= 0 || signal?.aborted) break;
      const retryMs = Math.min(10_000, intervalMs * (2 ** Math.min(transientFailures++, 4)));
      await delay(Math.min(retryMs, remaining));
      continue;
    }
    transientFailures = 0;
    if (result.status !== previousStatus && typeof onStatus === 'function') {
      previousStatus = result.status;
      try { await onStatus(result.status); } catch { /* activity is advisory */ }
    }
    if (['succeeded', 'failed', 'denied', 'expired', 'unknown'].includes(result.status)) return result;
    if (!['awaiting_device', 'executing'].includes(result.status)) return unknown();
    if (typeof assertActive === 'function') {
      try { await assertActive(); } catch { return unknown(); }
    }
    const remaining = deadline - monotonicNow();
    if (remaining <= 0 || signal?.aborted) break;
    await delay(Math.min(intervalMs, remaining));
  }
  return unknown();
}

// A failed or timed-out proposal is ambiguous. A retry reads the original
// durable request ID before creating any new nonce, and matches every target.
export async function submitOrResumeWindowsServiceProposal({ action, projection, riskMode, authenticatedPrincipalKind, verifiedOwnerDevice, client,
  kid, privateKey, assertActive, now = Date.now() } = {}) {
  if (!['safe', 'recommended'].includes(riskMode) || !ownerRunAuthorized(authenticatedPrincipalKind, verifiedOwnerDevice)) {
    fail('SERVICE_PROFILE_DENIED', 'This profile cannot request an owner service approval');
  }
  const target = boundService(action, projection);
  const { requestId, actionId } = windowsServiceRequestIds(action);
  if (!client || typeof client.status !== 'function' || typeof client.health !== 'function' || typeof client.proposeServiceControl !== 'function' ||
      typeof assertActive !== 'function' || !privateKey || !id.test(kid || '') || !Number.isSafeInteger(now) || now < 1) {
    fail('SERVICE_PROPOSAL_UNAVAILABLE', 'Service proposal dependencies are unavailable');
  }
  const matches = result => matchesServiceResult(result, action, target, requestId, actionId);
  const resume = result => {
    if (!matches(result)) fail('SERVICE_BINDING_CONFLICT', 'Existing service request does not match this operation');
    return { ...result, expiresMs: result.serviceControl.expiresMs, duplicate: true };
  };
  let existing = await client.status(requestId);
  assertBrokerStatusAvailable(existing);
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
    return { ...result, expiresMs: grant.expiresMs, duplicate: false };
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
