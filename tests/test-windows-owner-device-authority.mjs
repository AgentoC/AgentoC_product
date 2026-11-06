import assert from 'node:assert/strict';
import { captureWindowsOwnerDevice, validateWindowsOwnerDevice } from '../chat/windows-owner-device-authority.mjs';
import { getWindowsManagedAutoInstallStatus } from '../chat/windows-managed-auto-install.mjs';

const descriptor = { principalKind: 'trusted_device', deviceId: 'phone', accountId: 'account', bindingAuthorityRevision: '3' };
let device = { id: 'phone', status: 'bound', accountId: 'account', bindingAuthorityRevision: '3',
  boundAt: '2026-11-01T00:00:00Z', devicePublicKey: 'test-public-key' };
let authorized = true;
const deps = { getDevice: async () => device, authorize: async () => { if (!authorized) throw new Error('revoked'); return { accountId: 'account' }; } };
const binding = await captureWindowsOwnerDevice(descriptor, deps);
assert.ok(binding);
assert.equal(await validateWindowsOwnerDevice(binding, deps), true);
assert.equal(await captureWindowsOwnerDevice({ ...descriptor, principalKind: 'temporary_device' }, deps), null);
for (const change of [{ revokedAt: 'now' }, { status: 'provisional' }, { devicePublicKey: 'rotated' },
  { boundAt: 'later' }, { bindingAuthorityRevision: '4' }, { accountId: 'other' }, { id: 'other' }]) {
  const before = device; device = { ...before, ...change };
  assert.equal(await validateWindowsOwnerDevice(binding, deps), false, JSON.stringify(change));
  device = before;
}
authorized = false;
assert.equal(await validateWindowsOwnerDevice(binding, deps), false);
assert.equal(await captureWindowsOwnerDevice(descriptor, deps), null);
const userStore = { status: async () => ({ status: 'succeeded' }) };
const installBinding = { authenticatedPrincipalKind: 'trusted_device', sessionId: 's', runId: 'r', turnId: 't', requestKey: 'k' };
await assert.rejects(getWindowsManagedAutoInstallStatus({ binding: installBinding, platform: 'win32' }, { userStore }), { code: 'AUTO_INSTALL_STATUS_UNAVAILABLE' });
assert.equal((await getWindowsManagedAutoInstallStatus({ binding: { ...installBinding, verifiedOwnerDevice: true }, platform: 'win32' }, { userStore })).status, 'succeeded');
await assert.rejects(getWindowsManagedAutoInstallStatus({ binding: { ...installBinding, authenticatedPrincipalKind: 'temporary_device', verifiedOwnerDevice: true }, platform: 'win32' }, { userStore }), { code: 'AUTO_INSTALL_STATUS_UNAVAILABLE' });
console.log('windows owner device authority checks passed');
