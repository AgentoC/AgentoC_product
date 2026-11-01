import { broadcastOwners } from './ws-clients.mjs';
import { randomUUID } from 'node:crypto';

const TERMINAL_STATUSES = new Set(['succeeded', 'denied', 'failed', 'expired', 'unknown']);
const expiredNotified = new Set();
const MAX_EXPIRED_NOTICES = 1024;
const revisionEpoch = randomUUID();
let revisionNumber = 0;
const revisionWaiters = new Set();
const waitersByDevice = new Map();
const MAX_WAITERS = 16;
const MAX_WAITERS_PER_DEVICE = 4;

/** Opaque process-epoch token. A Host restart must invalidate a client's old token. */
export function currentWindowsBrokerApprovalRevision() {
  return `${revisionEpoch}:${revisionNumber}`;
}

/** Waits for a hint without holding the privileged Broker pipe. */
export function waitForWindowsBrokerApprovalChange(deviceId, afterRevision, waitMs, signal) {
  if (afterRevision !== currentWindowsBrokerApprovalRevision()) return Promise.resolve(true);
  if (signal?.aborted) return Promise.resolve(false);
  if (revisionWaiters.size >= MAX_WAITERS || (waitersByDevice.get(deviceId) || 0) >= MAX_WAITERS_PER_DEVICE) {
    return Promise.reject(Object.assign(new Error('Broker pending wait capacity reached'), {
      code: 'BROKER_WAIT_CAPACITY',
    }));
  }
  return new Promise((resolve) => {
    let timer;
    let settled = false;
    const finish = (changed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      revisionWaiters.delete(finish);
      const remaining = (waitersByDevice.get(deviceId) || 1) - 1;
      if (remaining) waitersByDevice.set(deviceId, remaining);
      else waitersByDevice.delete(deviceId);
      signal?.removeEventListener('abort', abort);
      resolve(changed);
    };
    const abort = () => finish(false);
    timer = setTimeout(() => finish(false), waitMs);
    revisionWaiters.add(finish);
    waitersByDevice.set(deviceId, (waitersByDevice.get(deviceId) || 0) + 1);
    signal?.addEventListener('abort', abort, { once: true });
    // Covers a revision published between the initial comparison and registration.
    if (afterRevision !== currentWindowsBrokerApprovalRevision() || signal?.aborted) {
      finish(afterRevision !== currentWindowsBrokerApprovalRevision());
    }
  });
}

function advanceRevision() {
  revisionNumber++;
  for (const wake of [...revisionWaiters]) wake(true);
}

/** A target-local hint only. Clients must fetch and verify the signed Broker snapshot. */
export function publishWindowsBrokerApprovalInvalidation(response, { action, requestId, broadcast = broadcastOwners } = {}) {
  if (response?.type !== 'result') return false;
  if (action === 'propose' && response.status !== 'awaiting_device') return false;
  if (action === 'decision' && !TERMINAL_STATUSES.has(response.status)) return false;
  if (action === 'status') {
    if (response.status !== 'expired' || !requestId || expiredNotified.has(requestId)) return false;
  } else if (action !== 'propose' && action !== 'decision') return false;
  // The connected device may be waiting through its verified HTTP carrier,
  // where the Owner WebSocket broadcast is not delivered.
  advanceRevision();
  try { broadcast({ type: 'windows_broker_approvals_invalidated' }); }
  catch { return false; }
  if (action === 'status') {
    expiredNotified.add(requestId);
    if (expiredNotified.size > MAX_EXPIRED_NOTICES) expiredNotified.delete(expiredNotified.values().next().value);
  }
  return true;
}
