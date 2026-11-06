import { createHash } from 'node:crypto';
import { getTrustedDeviceStatus } from './trusted-devices.mjs';
import { authorizeDeviceBinding } from '../lib/binding-authority-runtime.mjs';

const text = value => typeof value === 'string' ? value.trim() : '';
const fingerprint = key => text(key) ? createHash('sha256').update(text(key)).digest('hex') : '';

export function authenticatedOwnerDeviceDescriptor(authSession) {
  if (authSession?.role !== 'owner' || authSession?.principalKind !== 'trusted_device' || !text(authSession.deviceId)) return null;
  return { principalKind: 'trusted_device', deviceId: text(authSession.deviceId),
    accountId: text(authSession.accountId), bindingAuthorityRevision: text(authSession.bindingAuthorityRevision) };
}

export function parseOwnerDeviceDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4 ||
      Object.keys(value).some(key => !['principalKind', 'deviceId', 'accountId', 'bindingAuthorityRevision'].includes(key)) ||
      value.principalKind !== 'trusted_device' || typeof value.deviceId !== 'string' || !value.deviceId.trim() || value.deviceId.length > 256 ||
      typeof value.accountId !== 'string' || value.accountId.length > 256 ||
      typeof value.bindingAuthorityRevision !== 'string' || !/^(?:|0|[1-9][0-9]{0,18})$/.test(value.bindingAuthorityRevision) ||
      [value.deviceId, value.accountId].some(item => item.includes('\0'))) throw new Error('Invalid authenticated device descriptor');
  return { principalKind: value.principalKind, deviceId: value.deviceId, accountId: value.accountId,
    bindingAuthorityRevision: value.bindingAuthorityRevision };
}

// The descriptor originates at the authenticated HTTP boundary, never from
// provider tool input. Keep enough identity to reject revoke/re-enroll and
// account-generation changes while a long-running turn is still active.
export async function captureWindowsOwnerDevice(descriptor, deps = {}) {
  if (!descriptor || descriptor.principalKind !== 'trusted_device' || !text(descriptor.deviceId)) return null;
  const device = await (deps.getDevice || getTrustedDeviceStatus)(descriptor.deviceId);
  if (!device || device.id !== descriptor.deviceId || device.revokedAt || !['bound', 'legacy_trusted'].includes(device.status) ||
      !fingerprint(device.devicePublicKey) ||
      (text(descriptor.accountId) && text(device.accountId) && text(descriptor.accountId) !== text(device.accountId)) ||
      text(descriptor.bindingAuthorityRevision) !== text(device.bindingAuthorityRevision)) return null;
  try {
    const authority = await (deps.authorize || authorizeDeviceBinding)(device, { credential: true, tokenRevision: descriptor.bindingAuthorityRevision });
    if (text(descriptor.accountId) && text(authority?.accountId) !== text(descriptor.accountId)) return null;
  } catch { return null; }
  return { deviceId: device.id, accountId: text(descriptor.accountId),
    bindingAuthorityRevision: text(device.bindingAuthorityRevision),
    keyFingerprint: fingerprint(device.devicePublicKey), boundAt: text(device.boundAt) };
}

export async function validateWindowsOwnerDevice(snapshot, deps = {}) {
  if (!snapshot || !text(snapshot.deviceId) || !/^[a-f0-9]{64}$/.test(text(snapshot.keyFingerprint))) return false;
  const device = await (deps.getDevice || getTrustedDeviceStatus)(snapshot.deviceId);
  if (!device || device.id !== snapshot.deviceId || device.revokedAt || !['bound', 'legacy_trusted'].includes(device.status) ||
      fingerprint(device.devicePublicKey) !== snapshot.keyFingerprint || text(device.boundAt) !== text(snapshot.boundAt) ||
      text(device.bindingAuthorityRevision) !== text(snapshot.bindingAuthorityRevision) ||
      (text(snapshot.accountId) && text(device.accountId) && text(snapshot.accountId) !== text(device.accountId))) return false;
  try {
    const authority = await (deps.authorize || authorizeDeviceBinding)(device, { credential: true, tokenRevision: snapshot.bindingAuthorityRevision || undefined });
    if (text(snapshot.accountId) && text(authority?.accountId) !== text(snapshot.accountId)) return false;
    return true;
  } catch { return false; }
}
