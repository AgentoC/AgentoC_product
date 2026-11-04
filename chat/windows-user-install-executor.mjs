import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { assertOrdinaryWindowsExecutionIdentity } from '../lib/windows-execution-identity.mjs';
import { verifySemanticCapability } from './semantic-capability.mjs';
import { revalidateWindowsUserWingetInstall } from './semantic-windows-adapter.mjs';

const defaultExecFile = promisify(execFileCallback);
const fail = (code) => ({ ok: false, status: 'failed', code });

// Resolver observation timestamps and capability nonces change on a retry.
// Identify the actual install by its signed, stable package facts instead.
export function windowsUserInstallOperationFingerprint(capability) {
  const operation = capability?.operations?.[0];
  const input = operation?.adapterInput || {};
  return createHash('sha256').update(JSON.stringify([
    capability?.adapter, operation?.primaryAction, operation?.platform, operation?.executionClass,
    operation?.resourceSnapshotIdentity, input.manager, input.source, input.packages,
    input.requestedVersions, input.resolvedVersions, input.requestedInstallScope,
  ])).digest('hex');
}

// This is an execution primitive, not an authorization endpoint. The caller
// must supply a durable, atomic claim/finish store and a trusted signing key.
// No requester-provided executable, environment, or arbitrary argv is used.
export async function executeWindowsUserInstall({ capability, binding, riskMode, publicKey, cwd, expectedOwnerSid, platform = process.platform }, {
  assertIdentity = assertOrdinaryWindowsExecutionIdentity,
  revalidate = revalidateWindowsUserWingetInstall,
  verify = verifySemanticCapability,
  claim,
  finish,
  assertActive,
  execFile = defaultExecFile,
  now = () => Date.now(),
} = {}) {
  if (platform !== 'win32' || !['recommended', 'full-auto'].includes(riskMode) || !/^S-1-\d+(?:-\d+)+$/i.test(expectedOwnerSid || '') || typeof claim !== 'function'
      || typeof finish !== 'function' || typeof assertActive !== 'function' || typeof execFile !== 'function') {
    return fail('USER_INSTALL_CONFIGURATION_INVALID');
  }
  if (!verify(capability, { publicKey, now: now() }).ok || capability.authMode !== 'policy-auto'
      || capability.adapter !== 'windows-winget-install/v1' || capability.operations?.length !== 1) return fail('USER_INSTALL_CAPABILITY_INVALID');
  const operation = capability.operations[0];
  if (!['', 'user'].includes(operation?.adapterInput?.requestedInstallScope)
      || typeof capability.windowsExecutionSid !== 'string' || capability.windowsExecutionSid.toLowerCase() !== expectedOwnerSid.toLowerCase()
      || ['sessionId', 'runId', 'turnId'].some((key) => !binding?.[key] || binding[key] !== capability[key] || binding[key] !== operation.requestBinding?.[key])
      || !binding?.requestKey || binding.requestKey !== operation.requestBinding?.requestKey) return fail('USER_INSTALL_BINDING_MISMATCH');
  try {
    const identity = await assertIdentity({ platform });
    if (identity?.isService === true || typeof identity?.sid !== 'string' || identity.sid.toLowerCase() !== expectedOwnerSid.toLowerCase()) throw new Error('run identity does not match an interactive owner');
    await assertActive();
  } catch { return fail('USER_INSTALL_IDENTITY_OR_RUN_INVALID'); }
  let checked;
  try { checked = await revalidate(capability, { execFile, cwd }); }
  catch { return fail('USER_INSTALL_REVALIDATION_FAILED'); }
  if (!checked?.ok || !checked.invocation) return fail('USER_INSTALL_REVALIDATION_FAILED');
  if (!verify(capability, { publicKey, now: now() }).ok) return fail('USER_INSTALL_CAPABILITY_EXPIRED');
  let reservation;
  try { reservation = await claim({ binding, nonce: capability.nonce, operationFingerprint: windowsUserInstallOperationFingerprint(capability) }); }
  catch { return { ok: false, status: 'unknown', code: 'USER_INSTALL_OUTCOME_UNKNOWN' }; }
  if (reservation?.duplicate === true) return { ok: reservation.status === 'succeeded', status: reservation.status || 'unknown', code: reservation.code || '', duplicate: true };
  if (reservation?.claimed !== true) return fail('USER_INSTALL_CLAIM_FAILED');
  let result;
  let spawnAttempted = false;
  try {
    await assertActive();
    if (!verify(capability, { publicKey, now: now() }).ok) throw Object.assign(new Error('capability expired'), { code: 'USER_INSTALL_CAPABILITY_EXPIRED' });
    spawnAttempted = true;
    const output = await execFile(checked.invocation.executable, checked.invocation.argv, {
      cwd: checked.invocation.cwd, windowsHide: true, timeout: 10 * 60_000, maxBuffer: 1024 * 1024,
    });
    result = { status: 'succeeded', code: '', stdout: String(output?.stdout || '').slice(0, 8192) };
  } catch (error) {
    const noSpawn = !spawnAttempted;
    const exited = Number.isInteger(error?.code) && !error?.killed && !error?.signal;
    result = { status: noSpawn || exited ? 'failed' : 'unknown', code: noSpawn ? (error?.code === 'USER_INSTALL_CAPABILITY_EXPIRED' ? error.code : 'USER_INSTALL_RUN_CHANGED') : exited ? 'USER_INSTALL_FAILED' : 'USER_INSTALL_OUTCOME_UNKNOWN' };
  }
  try { await finish({ binding, nonce: capability.nonce, ...result }); }
  catch { return { ok: false, status: 'unknown', code: 'USER_INSTALL_OUTCOME_UNKNOWN' }; }
  return { ok: result.status === 'succeeded', ...result };
}
