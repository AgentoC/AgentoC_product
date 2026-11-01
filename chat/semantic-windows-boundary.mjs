/**
 * Windows runtime boundary facts.
 *
 * These validators consume only facts returned by a trusted Windows adapter.
 * They do not inspect caller claims and do not attempt to emulate Windows
 * APIs on Linux. Missing, unsigned, or ambiguous facts are rejected.
 */

export const WINDOWS_PEER_TRANSPORT = 'named-pipe';
export const WINDOWS_SERVICE_MANAGER = 'windows-service';
export const WINDOWS_ACL_PROVIDER = 'windows-acl';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fail(code, error) {
  return { ok: false, code, error };
}

export function validateWindowsPeerIdentity(facts = {}, expected = {}) {
  if (facts?.platform !== 'win32' || facts?.transport !== WINDOWS_PEER_TRANSPORT) {
    return fail('WINDOWS_PEER_TRANSPORT_UNSUPPORTED', 'Windows executor must use a named-pipe peer transport');
  }
  if (facts.authenticated !== true || facts.sameUser !== true || facts.integrity !== 'high') {
    return fail('WINDOWS_PEER_IDENTITY_UNVERIFIED', 'Windows named-pipe peer identity is not verified');
  }
  const expectedSid = trimString(expected.sid);
  const peerSid = trimString(facts.sid);
  if (!expectedSid || !peerSid || expectedSid.toLowerCase() !== peerSid.toLowerCase()) {
    return fail('WINDOWS_PEER_IDENTITY_MISMATCH', 'Windows peer SID does not match the expected service identity');
  }
  return { ok: true, code: '', sid: peerSid };
}

export function validateWindowsServiceFacts(facts = {}, expected = {}) {
  if (facts?.platform !== 'win32' || facts?.manager !== WINDOWS_SERVICE_MANAGER) {
    return fail('WINDOWS_SERVICE_PROVIDER_UNSUPPORTED', 'Windows Service facts must come from the Windows Service provider');
  }
  const serviceName = trimString(facts.serviceName || facts.name);
  if (!serviceName || serviceName !== trimString(expected.serviceName)) {
    return fail('WINDOWS_SERVICE_IDENTITY_MISMATCH', 'Windows Service identity is missing or changed');
  }
  if (facts.exists !== true || !trimString(facts.definitionHash)) {
    return fail('WINDOWS_SERVICE_FACTS_UNVERIFIED', 'Windows Service existence and definition hash are required');
  }
  return { ok: true, code: '', serviceName, definitionHash: trimString(facts.definitionHash) };
}

export function validateWindowsAclFacts(facts = {}, expected = {}) {
  if (facts?.platform !== 'win32' || facts?.provider !== WINDOWS_ACL_PROVIDER) {
    return fail('WINDOWS_ACL_PROVIDER_UNSUPPORTED', 'ACL facts must come from the Windows ACL provider');
  }
  const path = trimString(facts.canonicalPath);
  if (!path || path.toLowerCase() !== trimString(expected.canonicalPath).toLowerCase()) {
    return fail('WINDOWS_ACL_PATH_MISMATCH', 'Windows ACL path does not match the resolved resource');
  }
  if (!trimString(facts.ownerSid) || !trimString(facts.descriptorHash) || facts.protected !== true) {
    return fail('WINDOWS_ACL_FACTS_UNVERIFIED', 'Windows ACL owner, protection, and descriptor hash are required');
  }
  return {
    ok: true,
    code: '',
    canonicalPath: path,
    ownerSid: trimString(facts.ownerSid),
    descriptorHash: trimString(facts.descriptorHash),
  };
}

export function unsupportedWindowsCapability(capability) {
  return {
    ok: false,
    code: 'WINDOWS_CAPABILITY_UNIMPLEMENTED',
    error: `${trimString(capability) || 'Windows capability'} is not implemented on this runtime`,
  };
}
