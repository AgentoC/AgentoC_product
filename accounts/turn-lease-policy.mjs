// Shared account quota facts: temporary phones consume the same slots as account-enrolled phones.
import { normalizeTurnPlan, resolveTurnDeviceLimits } from '../lib/turn-authorization.mjs';
const text = (value) => typeof value === 'string' ? value.trim() : '';

export function getTurnConnectionLeases(draft) {
  if (!Array.isArray(draft.turnConnectionLeases)) draft.turnConnectionLeases = [];
  return draft.turnConnectionLeases;
}

export function resolveAccountEntitlement(draft, accountId, nowMs) {
  if (!Array.isArray(draft.accountEntitlements)) draft.accountEntitlements = [];
  const record = draft.accountEntitlements.find((item) => item.accountId === accountId);
  const expiresMs = Date.parse(record?.expiresAt || '');
  const active = record && (!record.expiresAt || (Number.isFinite(expiresMs) && expiresMs > nowMs));
  const plan = active ? normalizeTurnPlan(record.plan) : 'free';
  const limits = resolveTurnDeviceLimits({ plan });
  return { plan, limits: { phones: limits.phones, computers: limits.computers },
    status: active ? 'active' : record ? 'expired' : 'default',
    source: active ? text(record.source) || 'default' : 'default', expiresAt: text(record?.expiresAt) };
}

export function effectiveDeviceKind(device) {
  if (device?.deviceKind === 'phone' || device?.deviceKind === 'computer') return device.deviceKind;
  return device?.deviceId && device.deviceId === device.instanceId ? 'computer' : 'phone';
}

export function isActiveTurnConnectionLease(lease, nowMs) {
  if (!lease || !['reserved', 'connected'].includes(text(lease.status))) return false;
  if (lease.handoffFrom && !lease.handoffCommittedAt) {
    const deadline = Date.parse(lease.handoffDeadline || '');
    if (!Number.isFinite(deadline) || deadline <= nowMs) return false;
  }
  const expiresMs = Date.parse(lease.expiresAt || '');
  return Number.isFinite(expiresMs) && expiresMs > nowMs;
}

export function activeTurnConnectionState(draft, accountId, nowMs, { excludeConnectionId = '' } = {}) {
  const active = getTurnConnectionLeases(draft).filter((lease) => lease.accountId === accountId
    && lease.connectionId !== excludeConnectionId && isActiveTurnConnectionLease(lease, nowMs));
  const quotaDeviceId = (lease) => text(lease.quotaDeviceId) || text(lease.deviceId);
  return { leases: active,
    activePhoneDeviceIds: [...new Set(active.filter((lease) => effectiveDeviceKind(lease) === 'phone').map(quotaDeviceId).filter(Boolean))],
    activeComputerDeviceIds: [...new Set(active.filter((lease) => effectiveDeviceKind(lease) === 'computer').map((lease) => lease.deviceId).filter(Boolean))],
    activeInstanceIds: [...new Set(active.map((lease) => lease.instanceId).filter(Boolean))] };
}

/** Only operator policy may waive connection quotas; identity checks remain mandatory. */
export function createAccountEntitlementResolver(demoAccountAuth = null) {
  return (draft, accountId, nowMs) => {
    const stored = resolveAccountEntitlement(draft, accountId, nowMs);
    if (demoAccountAuth?.accountId !== accountId || !demoAccountAuth.unlimitedConnections) return stored;
    demoAccountAuth.assertAccount(draft, accountId);
    return { ...stored, status: 'active', source: 'review-policy', expiresAt: '',
      limits: { phones: 2147483647, computers: 2147483647, unlimited: true } };
  };
}
