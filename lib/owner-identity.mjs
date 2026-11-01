// 跨设备授权使用的 owner 身份。
//
// Owner identity is the Accounts accountId. Device ownership is separately
// proven by short-lived pairing and private-key signatures.
import { getOwnerAccountBinding } from './owner-account-auth.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export async function getCrossDeviceOwnerIdentity() {
  const accountBinding = await getOwnerAccountBinding();
  const accountId = trimString(accountBinding?.accountId);
  if (accountId) {
    return {
      id: accountId,
      kind: 'account',
    };
  }
  return null;
}
