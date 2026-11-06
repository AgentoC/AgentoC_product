// State transitions for a bounded, same-pair TURN handoff. Callers must
// authenticate the instance and mutate the complete lease set atomically.
import { isActiveTurnConnectionLease } from './turn-lease-policy.mjs';

export const TURN_HANDOFF_MAX_MS = 60_000;
const active = (lease, now) => isActiveTurnConnectionLease(lease, now);
const samePair = (a, b) => a.accountId === b.accountId && a.instanceId === b.instanceId
  && a.deviceId === b.deviceId && a.deviceKind === b.deviceKind && a.quotaDeviceId === b.quotaDeviceId;
const fail = (code) => { throw Object.assign(new Error(code), { code, statusCode: 409 }); };

/** Expired offers never retire the old carrier and cannot later be committed. */
export function expireTurnHandoffs(leases, now) {
  for (const lease of leases) {
    if (!lease.handoffFrom || lease.handoffCommittedAt || lease.status === 'released') continue;
    const deadline = Date.parse(lease.handoffDeadline || '');
    if (!Number.isFinite(deadline) || deadline <= now || !active(lease, now)) {
      const at = new Date(now).toISOString();
      Object.assign(lease, { status: 'released', releasedAt: at, updatedAt: at, releaseReason: 'handoff-expired' });
    }
  }
}

/** Prepare one replacement without invalidating its predecessor. */
export function prepareTurnHandoff(leases, predecessorId, next, now, predecessorSignedExpiry) {
  expireTurnHandoffs(leases, now);
  if (!next?.connectionId || !active(next, now) || next.handoffFrom || next.handoffCommittedAt) fail('turn_handoff_replacement_invalid');
  const old = leases.find(lease => lease.connectionId === predecessorId);
  if (!old || !active(old, now) || !samePair(old, next)) fail('turn_handoff_predecessor_invalid');
  if (old.handoffFrom && !old.handoffCommittedAt) fail('turn_handoff_predecessor_pending');
  if (leases.some(lease => lease.connectionId === next.connectionId)) fail('turn_handoff_generation_exists');
  if (leases.some(lease => lease !== old && active(lease, now) && samePair(old, lease))) {
    fail('turn_handoff_already_pending');
  }
  // The caller verifies this signed carrier bound and binds it into the
  // authenticated operation; the central lease alone may outlive the plan.
  const deadline = Math.min(now + TURN_HANDOFF_MAX_MS, Date.parse(old.expiresAt),
    Date.parse(next.expiresAt), Date.parse(predecessorSignedExpiry || ''));
  if (!Number.isFinite(deadline) || deadline <= now) fail('turn_handoff_deadline_invalid');
  const pending = { ...next, handoffFrom: predecessorId, handoffDeadline: new Date(deadline).toISOString(), handoffCommittedAt: '' };
  leases.push(pending);
  return pending;
}

/** Only an authenticated standby may commit; old requests drain until expiry. */
export function commitTurnHandoff(leases, nextId, now) {
  expireTurnHandoffs(leases, now);
  const next = leases.find(lease => lease.connectionId === nextId);
  const old = leases.find(lease => lease.connectionId === next?.handoffFrom);
  if (!next || !old || !active(next, now) || !active(old, now) || !samePair(old, next)
    || next.handoffCommittedAt || Date.parse(next.handoffDeadline || '') <= now) fail('turn_handoff_commit_invalid');
  next.handoffCommittedAt = new Date(now).toISOString();
  next.updatedAt = next.handoffCommittedAt;
  return next;
}

/** Abort only the uncommitted standby, never the active predecessor. */
export function abortTurnHandoff(leases, nextId, now) {
  const next = leases.find(lease => lease.connectionId === nextId);
  if (!next || !next.handoffFrom || next.handoffCommittedAt || !active(next, now)) return false;
  const at = new Date(now).toISOString();
  Object.assign(next, { status: 'released', updatedAt: at, releasedAt: at, releaseReason: 'handoff-aborted' });
  return true;
}
