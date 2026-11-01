import { checkedTemporaryId, temporaryPairingError } from './temporary-pairing-protocol.mjs';

const keys = ['version', 'instanceId', 'grantId', 'deviceId', 'invitationId', 'deviceKeyFingerprint', 'bindingStamp', 'expiresAt'];
export function parseTemporaryOperationAuthority(value) {
  try {
    if (!value || value.version !== 1 || Object.keys(value).length !== keys.length
      || Object.keys(value).some(k => !keys.includes(k))
      || typeof value.instanceId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value.instanceId)
      || !/^[a-f0-9]{64}$/.test(value.deviceKeyFingerprint) || !/^[a-f0-9]{64}$/.test(value.bindingStamp)
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0 || value.expiresAt % 1000 !== 0) throw new Error();
    checkedTemporaryId(value.grantId, 'rtg'); checkedTemporaryId(value.deviceId, 'rdev'); checkedTemporaryId(value.invitationId, 'rti');
    return Object.fromEntries(keys.map(k => [k, value[k]]));
  } catch { throw temporaryPairingError('temporary_operation_authority_invalid', 403); }
}

// Provider choice and privilege controls stay with the PC-created Session.
export function assertTemporaryMessageRequest(request, authority) {
  const allowed = ['model', 'effort', 'thinking', 'serviceTier', 'uiLanguage'];
  if (Object.keys(request.runOptions || {}).some(k => !allowed.includes(k))
    || Date.parse(request.expiresAt) > authority.expiresAt) {
    throw temporaryPairingError('temporary_message_options_denied', 403);
  }
}
