import { prepareSemanticApproval, authorizeWindowsAutomaticInstall, authorizeWindowsUserInstall, authorizeWindowsMSIAutomaticInstall } from './semantic-approval.mjs';
import { queryWindowsBrokerAutoInstall, submitOrResumeWindowsBrokerAutoInstall } from './windows-auto-install-authorization.mjs';
import { createWindowsUserInstallAuthorization } from './windows-auto-install-authorization.mjs';
import { verifySemanticCapability } from './semantic-capability.mjs';
import { createWindowsPrivilegedBrokerClient } from './windows-privileged-broker.mjs';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { loadInstanceIdentity } from '../lib/instance-identity.mjs';
import { createWindowsUserInstallStore } from './windows-user-install-store.mjs';
import { submitOrResumeWindowsMSIInstall } from './windows-msi-auto-install.mjs';
import { submitOrResumeWindowsOwnerBrokerInstall } from './windows-owner-broker-install.mjs';

// This flag is computed by the server after rechecking the run-bound paired
// device. It must never be copied from a provider request.
function ownerRunAuthorized(binding) {
  return binding?.authenticatedPrincipalKind === 'owner' ||
    (binding?.authenticatedPrincipalKind === 'trusted_device' && binding?.verifiedOwnerDevice === true);
}

export async function loadWindowsAutoInstallSigningKey(options = {}) {
  const identity = await loadInstanceIdentity(options);
  if (!identity?.instanceId || !identity?.privateKey) return null;
  return { kid: identity.instanceId, privateKey: createPrivateKey(identity.privateKey) };
}

// Pin only the validated public half in Run-owned state. Never place the
// instance private key in a manifest, provider environment, or tool payload.
export async function loadWindowsAutoInstallPublicIdentity(options = {}) {
  const identity = await loadInstanceIdentity(options);
  if (!identity?.instanceId || !identity?.publicKey) return null;
  const key = createPublicKey(identity.publicKey);
  if (key.asymmetricKeyType !== 'ed25519') return null;
  return { kid: identity.instanceId, publicKey: key.export({ type: 'spki', format: 'pem' }).toString() };
}

export async function getWindowsManagedAutoInstallStatus({ binding, platform = process.platform }, deps = {}) {
  if (platform !== 'win32' || !ownerRunAuthorized(binding)) {
    throw Object.assign(new Error('Automatic installation status is unavailable'), { code: 'AUTO_INSTALL_STATUS_UNAVAILABLE' });
  }
  const requestBinding = { sessionId: binding.sessionId, runId: binding.runId, turnId: binding.turnId, requestKey: binding.requestKey };
  const userStatus = await (deps.userStore || createWindowsUserInstallStore()).status(requestBinding);
  if (userStatus) return { ...userStatus, requestKey: requestBinding.requestKey };
  const result = await queryWindowsBrokerAutoInstall({ client: deps.client || createWindowsPrivilegedBrokerClient(), binding: requestBinding });
  return { ...result, requestKey: requestBinding.requestKey };
}

// Private control-plane preparation. `runExecutionSid` is read from the Run
// record bound by the supervisor, never from the provider's request payload.
// Issuing this capability does not launch or claim an installation.
export async function prepareWindowsManagedUserInstall({ actions, binding, riskMode, trustedContext, runExecutionSid, runExecutionIsService, platform = process.platform }, deps = {}) {
  if (platform !== 'win32' || !['recommended', 'full-auto'].includes(riskMode) || !ownerRunAuthorized(binding)
      || runExecutionIsService === true
      || !/^S-1-\d+(?:-\d+)+$/i.test(runExecutionSid || '') || !Array.isArray(actions) || actions.length !== 1
      || typeof actions[0]?.command !== 'string' || !/^\s*winget(?:\.exe)?\s+(?:install|add)(?:\s|$)/i.test(actions[0].command)) return null;
  const requestBinding = { sessionId: binding.sessionId, runId: binding.runId, turnId: binding.turnId, requestKey: binding.requestKey };
  const prepared = await (deps.prepare || prepareSemanticApproval)({
    request: { ...requestBinding, rawCommand: actions[0].command, executionClass: 'host', tool: 'approved-action', commandForm: 'argv' },
    trustedContext: { ...trustedContext, platform: 'win32' }, callerEvidence: {},
  });
  try { authorizeWindowsUserInstall({ prepared, riskMode, kid: 'eligibility-check' }); }
  catch (error) { if (error?.code === 'SEMANTIC_AUTO_SELECTION_DENIED') return null; throw error; }
  if (typeof deps.assertActive !== 'function') throw new Error('active run verification is required');
  await deps.assertActive();
  const key = await (deps.getKey || loadWindowsAutoInstallSigningKey)();
  if (!key?.kid || !key.privateKey) throw Object.assign(new Error('Automatic installation signing key is unavailable'), { code: 'AUTO_INSTALL_KEY_UNAVAILABLE' });
  const capability = createWindowsUserInstallAuthorization({ prepared, riskMode, kid: key.kid, privateKey: key.privateKey, expectedExecutionSid: runExecutionSid });
  return { capability, expectedExecutionSid: runExecutionSid };
}

export function verifyWindowsManagedUserInstallAuthorization({ authorization, pinnedIdentity, binding, runExecutionSid, now = Date.now() } = {}) {
  const capability = authorization?.capability;
  if (!pinnedIdentity?.kid || !pinnedIdentity?.publicKey || capability?.kid !== pinnedIdentity.kid
      || !/^S-1-\d+(?:-\d+)+$/i.test(runExecutionSid || '')
      || capability?.windowsExecutionSid !== runExecutionSid || authorization?.expectedExecutionSid !== runExecutionSid
      || capability?.authMode !== 'policy-auto' || capability?.adapter !== 'windows-winget-install/v1'
      || !['', 'user'].includes(capability?.operations?.[0]?.adapterInput?.requestedInstallScope)
      || ['sessionId', 'runId', 'turnId'].some((key) => !binding?.[key] || capability?.[key] !== binding[key])
      || !binding?.requestKey || capability?.operations?.[0]?.requestBinding?.requestKey !== binding.requestKey) return false;
  return verifySemanticCapability(capability, { publicKey: pinnedIdentity.publicKey, now }).ok;
}

// This path is for a run-bound, owner-authenticated managed action channel.
// Its input and context have already been checked by the control plane.
export async function tryWindowsManagedAutoInstall({ actions, binding, riskMode, trustedContext, runExecutionIsService = false, preflight = false, platform = process.platform }, deps = {}) {
  if (platform !== 'win32' || !['recommended', 'full-auto'].includes(riskMode) || !ownerRunAuthorized(binding) ||
      !Array.isArray(actions) || actions.length !== 1 || typeof actions[0]?.command !== 'string' ||
      !/^\s*(?:winget(?:\.exe)?\s+(?:install|add)|msiexec(?:\.exe)?\s+\/i)(?:\s|$)/i.test(actions[0].command)) return null;
  const requestBinding = { sessionId: binding.sessionId, runId: binding.runId, turnId: binding.turnId, requestKey: binding.requestKey };
  const prepared = await (deps.prepare || prepareSemanticApproval)({
    request: { ...requestBinding, rawCommand: actions[0].command, executionClass: 'host', tool: 'approved-action', commandForm: 'argv' },
    trustedContext: { ...trustedContext, platform: 'win32' }, callerEvidence: {},
  });
  if (prepared?.projection?.decisions?.[0]?.operation?.target?.kind === 'package_artifact') {
    try { authorizeWindowsMSIAutomaticInstall({ prepared, riskMode, kid: 'eligibility-check' }); }
    catch (error) { if (error?.code === 'SEMANTIC_AUTO_SELECTION_DENIED') return null; throw error; }
    if (typeof deps.assertActive !== 'function') throw new Error('active run verification is required');
    await deps.assertActive();
    if (typeof deps.loadKeys === 'function') await deps.loadKeys();
    const key = await (deps.getKey || loadWindowsAutoInstallSigningKey)();
    if (!key?.kid || !key.privateKey) throw Object.assign(new Error('MSI installation signing key is unavailable'), { code: 'AUTO_INSTALL_KEY_UNAVAILABLE' });
    const client = deps.client || createWindowsPrivilegedBrokerClient();
    const result = await (deps.submitMSI || submitOrResumeWindowsMSIInstall)({ client, prepared, riskMode, kid: key.kid, privateKey: key.privateKey, assertActive: deps.assertActive, preflight });
    return preflight ? result : { status: result.status, code: result.code || '', requestId: result.requestId, requestKey: requestBinding.requestKey, duplicate: result.duplicate === true };
  }
  const ownerScope = runExecutionIsService === true && ['', 'user'].includes(prepared?.projection?.decisions?.[0]?.operation?.target?.requestedInstallScope);
  try {
    // Only the shared, server-derived policy can make this eligible.
    (ownerScope ? authorizeWindowsUserInstall : authorizeWindowsAutomaticInstall)({ prepared, riskMode, kid: 'eligibility-check' });
  } catch (error) {
    if (error?.code === 'SEMANTIC_AUTO_SELECTION_DENIED') return null;
    throw error;
  }
  if (typeof deps.assertActive === 'function') await deps.assertActive();
  if (typeof deps.loadKeys === 'function') await deps.loadKeys();
  const key = await (deps.getKey || loadWindowsAutoInstallSigningKey)();
  if (!key?.kid || !key.privateKey) throw Object.assign(new Error('Automatic installation signing key is unavailable'), { code: 'AUTO_INSTALL_KEY_UNAVAILABLE' });
  const client = deps.client || createWindowsPrivilegedBrokerClient();
  if (preflight) {
    let health;
    try { health = await client.health(); } catch (error) { if (ownerScope) return { ready: false }; throw error; }
    let ownerReady = true;
    if (ownerScope) {
      try { ownerReady = (await client.ownerInstallIdentity())?.instanceId === key.kid; } catch { ownerReady = false; }
    }
    return { ready: ownerReady && health?.type === 'health' && health.autoInstallReady === true && health.autoInstallKeyId === key.kid };
  }
  const result = await (deps.submit || (ownerScope ? submitOrResumeWindowsOwnerBrokerInstall : submitOrResumeWindowsBrokerAutoInstall))({ client, prepared, riskMode, kid: key.kid, privateKey: key.privateKey, assertActive: deps.assertActive });
  return { status: result.status, code: result.code || '', requestId: result.requestId, requestKey: requestBinding.requestKey, duplicate: result.duplicate === true };
}
