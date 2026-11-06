import { TURN_CONNECTION_LEASES_FILE } from '../lib/config.mjs';
import {
  evaluateTurnConnectionAuthorization,
  normalizeTurnDeviceKind,
  normalizeTurnPlan,
} from '../lib/turn-authorization.mjs';
import { createSerialTaskQueue, readJson, writeJsonAtomic } from './fs-utils.mjs';
import { isTurnLeaseId, canAdmitTurnLeaseId, pruneTurnLeases, turnLeasePairClock, turnLeaseObservedAt } from '../lib/turn-lease-identity.mjs';
import { prepareTurnHandoff, commitTurnHandoff, expireTurnHandoffs } from '../accounts/turn-handoff-policy.mjs';

const leaseQueue = createSerialTaskQueue();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso(clock = Date.now) {
  return new Date(clock()).toISOString();
}

function normalizeState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    version: 1,
    leases: Array.isArray(source.leases)
      ? source.leases.map((entry) => ({
          connectionId: trimString(entry?.connectionId),
          accountId: trimString(entry?.accountId),
          instanceId: trimString(entry?.instanceId),
          deviceId: trimString(entry?.deviceId),
          quotaDeviceId: trimString(entry?.quotaDeviceId) || trimString(entry?.deviceId),
          // v1 leases represented the phone control connection and had no
          // deviceKind. Preserve that meaning during the additive rollout.
          deviceKind: normalizeTurnDeviceKind(entry?.deviceKind, 'phone'),
          plan: normalizeTurnPlan(entry?.plan),
          status: ['reserved', 'connected', 'released'].includes(trimString(entry?.status))
            ? trimString(entry.status)
            : 'reserved',
          createdAt: trimString(entry?.createdAt),
          updatedAt: trimString(entry?.updatedAt),
          expiresAt: trimString(entry?.expiresAt),
          releasedAt: trimString(entry?.releasedAt),
          releaseReason: trimString(entry?.releaseReason),
          handoffFrom: trimString(entry?.handoffFrom),
          handoffDeadline: trimString(entry?.handoffDeadline),
          handoffCommittedAt: trimString(entry?.handoffCommittedAt),
        })).filter((entry) => entry.connectionId && entry.accountId && entry.deviceId)
      : [],
  };
}

function isActiveLease(entry, nowMs) {
  if (!entry || !['reserved', 'connected'].includes(entry.status)) return false;
  if (entry.handoffFrom && !entry.handoffCommittedAt) {
    const deadline = Date.parse(entry.handoffDeadline || '');
    if (!Number.isFinite(deadline) || deadline <= nowMs) return false;
  }
  const expiresAtMs = Date.parse(entry.expiresAt || '');
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

async function mutateState(mutator, clock = Date.now) {
  return leaseQueue(async () => {
    const state = normalizeState(await readJson(TURN_CONNECTION_LEASES_FILE, null));
    const nowMs = clock();
    expireTurnHandoffs(state.leases, nowMs);
    state.leases = pruneTurnLeases(state.leases, nowMs)
      .filter((entry) => isActiveLease(entry, nowMs) || entry.status === 'released' || isTurnLeaseId(entry.connectionId));
    const result = await mutator(state, nowMs);
    await writeJsonAtomic(TURN_CONNECTION_LEASES_FILE, state, { mode: 0o600 });
    return result;
  });
}

export async function listActiveTurnConnectionDeviceIds({ accountId, deviceKind = '', clock = Date.now } = {}) {
  const normalizedAccountId = trimString(accountId);
  if (!normalizedAccountId) return [];
  const state = normalizeState(await readJson(TURN_CONNECTION_LEASES_FILE, null));
  const nowMs = clock();
  return [...new Set(state.leases
    .filter((entry) => entry.accountId === normalizedAccountId
      && (!normalizeTurnDeviceKind(deviceKind) || entry.deviceKind === normalizeTurnDeviceKind(deviceKind))
      && isActiveLease(entry, nowMs))
    .map((entry) => entry.quotaDeviceId || entry.deviceId))];
}

export async function listActiveTurnConnectionInstanceIds({ accountId, clock = Date.now } = {}) {
  const normalizedAccountId = trimString(accountId);
  if (!normalizedAccountId) return [];
  const state = normalizeState(await readJson(TURN_CONNECTION_LEASES_FILE, null));
  const nowMs = clock();
  return [...new Set(state.leases
    .filter((entry) => entry.accountId === normalizedAccountId && isActiveLease(entry, nowMs))
    .map((entry) => entry.instanceId)
    .filter(Boolean))];
}

export async function listActiveTurnConnectionCounts({ accountId, clock = Date.now } = {}) {
  const normalizedAccountId = trimString(accountId);
  if (!normalizedAccountId) return { activePhones: 0, activeComputers: 0 };
  const state = normalizeState(await readJson(TURN_CONNECTION_LEASES_FILE, null));
  const nowMs = clock();
  const active = state.leases.filter((entry) => entry.accountId === normalizedAccountId && isActiveLease(entry, nowMs));
  return {
    activePhones: new Set(active
      .filter((entry) => entry.deviceKind === 'phone')
      .map((entry) => entry.quotaDeviceId || entry.deviceId)).size,
    activeComputers: new Set(active.map((entry) => entry.instanceId).filter(Boolean)).size,
  };
}

export async function reserveTurnConnectionLease({
  accountId,
  instanceId,
  deviceId,
  deviceKind = '',
  plan = 'free',
  limits,
  connectionId,
  expiresAt,
  activePhones,
  activeComputers,
  handoffFrom = '',
  handoffDeadline = '',
  clock = Date.now,
} = {}) {
  const normalizedAccountId = trimString(accountId);
  const normalizedInstanceId = trimString(instanceId);
  const normalizedDeviceId = trimString(deviceId);
  const normalizedConnectionId = trimString(connectionId);
  if (!normalizedAccountId || !normalizedInstanceId || !normalizedDeviceId || !normalizedConnectionId || !trimString(expiresAt)) {
    const error = new Error('TURN lease identity and expiry are required');
    error.code = 'turn_lease_request_invalid';
    error.statusCode = 400;
    throw error;
  }
  const normalizedDeviceKind = normalizeTurnDeviceKind(deviceKind);
  return mutateState((state, nowMs) => {
    if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= nowMs) {
      throw Object.assign(new Error('A future TURN reservation deadline is required'), { statusCode: 400, code: 'turn_connection_expiry_invalid' });
    }
    const retired = state.leases.find(entry => entry.connectionId === normalizedConnectionId);
    if (retired && (retired.accountId !== normalizedAccountId || retired.instanceId !== normalizedInstanceId || retired.deviceId !== normalizedDeviceId)) {
      throw Object.assign(new Error('TURN reservation identity differs'), { statusCode: 409, code: 'turn_connection_identity_conflict' });
    }
    if (isTurnLeaseId(normalizedConnectionId) && !retired && !canAdmitTurnLeaseId(normalizedConnectionId, nowMs,
      turnLeasePairClock(state.leases, normalizedConnectionId, nowMs))) {
      throw Object.assign(new Error('TURN reservation admission window ended'), { statusCode: 409, code: 'turn_connection_generation_retired' });
    }
    if (isTurnLeaseId(normalizedConnectionId) && retired && !isActiveLease(retired, nowMs)) {
      throw Object.assign(new Error('TURN reservation already ended'), { statusCode: 409, code: 'turn_connection_generation_retired' });
    }
    const existing = state.leases.find((entry) => (
      entry.accountId === normalizedAccountId
      && entry.deviceId === normalizedDeviceId
      && entry.instanceId === normalizedInstanceId
      && entry.connectionId === normalizedConnectionId
      && isActiveLease(entry, nowMs)
    ));
    const activeDeviceIds = state.leases
      .filter((entry) => entry.accountId === normalizedAccountId
        && entry.deviceKind === normalizedDeviceKind
        && isActiveLease(entry, nowMs))
      .map((entry) => entry.deviceId);
    const activeInstanceIds = state.leases
      .filter((entry) => entry.accountId === normalizedAccountId && isActiveLease(entry, nowMs))
      .map((entry) => entry.instanceId);
    const decision = evaluateTurnConnectionAuthorization({
      accountId: normalizedAccountId,
      instanceId: normalizedInstanceId,
      deviceId: normalizedDeviceId,
      quotaDeviceId: normalizedDeviceId,
      accountPlan: plan,
      deviceKind: normalizedDeviceKind,
      limits,
      activeDeviceIds,
      activeInstanceIds,
      activePhones,
      activeComputers,
      nowMs,
    });
    if (!decision.authorized) {
      const error = new Error('TURN connection quota does not allow this device');
      error.code = decision.reasonCode;
      error.statusCode = 429;
      error.turnAuthorization = decision;
      throw error;
    }
    if (isTurnLeaseId(normalizedConnectionId) && existing) {
      if (handoffFrom && existing.handoffFrom !== handoffFrom) {
        throw Object.assign(new Error('TURN handoff predecessor differs'), { statusCode: 409, code: 'turn_handoff_request_invalid' });
      }
      existing.updatedAt = new Date(Math.max(nowMs, turnLeaseObservedAt(existing))).toISOString();
      return { ...decision, connectionId: existing.connectionId, leaseId: existing.connectionId, expiresAt: existing.expiresAt };
    }
    const timestamp = isTurnLeaseId(normalizedConnectionId)
      ? new Date(turnLeasePairClock(state.leases, normalizedConnectionId, nowMs)).toISOString() : nowIso(clock);
    if (isTurnLeaseId(normalizedConnectionId) && !handoffFrom) {
      for (const previous of state.leases) {
        if (previous.accountId === normalizedAccountId && previous.instanceId === normalizedInstanceId
          && previous.deviceId === normalizedDeviceId && isActiveLease(previous, nowMs)) {
          Object.assign(previous, { status: 'released', releasedAt: timestamp, updatedAt: timestamp, releaseReason: 'reservation-superseded' });
        }
      }
    }
    const lease = existing || {
      connectionId: normalizedConnectionId,
      accountId: normalizedAccountId,
      instanceId: normalizedInstanceId,
      deviceId: normalizedDeviceId,
      deviceKind: normalizeTurnDeviceKind(deviceKind),
      plan: decision.plan,
      status: 'reserved',
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: trimString(expiresAt),
      releasedAt: '',
    };
    lease.connectionId = normalizedConnectionId;
    lease.instanceId = normalizedInstanceId;
    lease.deviceKind = normalizedDeviceKind;
    lease.quotaDeviceId = lease.quotaDeviceId || normalizedDeviceId;
    lease.plan = decision.plan;
    lease.status = 'reserved';
    lease.updatedAt = timestamp;
    lease.expiresAt = trimString(expiresAt);
    lease.releasedAt = '';
    const reserved = existing ? lease : handoffFrom ? prepareTurnHandoff(state.leases, handoffFrom, lease, nowMs, handoffDeadline)
      : (state.leases.push(lease), lease);
    return { ...decision, connectionId: reserved.connectionId, leaseId: reserved.connectionId, expiresAt: reserved.expiresAt };
  }, clock);
}

export async function commitLocalTurnHandoff({ deviceId, connectionId, clock = Date.now } = {}) {
  return mutateState((state, nowMs) => {
    const lease = state.leases.find(entry => entry.connectionId === trimString(connectionId)
      && entry.deviceId === trimString(deviceId));
    if (!lease || !lease.handoffFrom) throw Object.assign(new Error('TURN handoff not found'), { code: 'turn_handoff_commit_invalid', statusCode: 409 });
    if (lease.handoffCommittedAt && isActiveLease(lease, nowMs)) return { committed: true };
    commitTurnHandoff(state.leases, lease.connectionId, nowMs);
    return { committed: true };
  }, clock);
}

export async function markTurnConnectionLeaseConnected({ deviceId, connectionId, clock = Date.now } = {}) {
  if (!trimString(connectionId)) throw Object.assign(new Error('Exact TURN reservation is required'), { statusCode: 400, code: 'turn_connection_id_required' });
  return mutateState((state) => {
    const lease = state.leases.find((entry) => (
      entry.deviceId === trimString(deviceId)
      && entry.connectionId === trimString(connectionId)
      && isActiveLease(entry, clock())
    ));
    if (!lease) return { updated: false };
    lease.status = 'connected';
    lease.updatedAt = new Date(Math.max(clock(), turnLeaseObservedAt(lease))).toISOString();
    return { updated: true, leaseId: lease.connectionId };
  }, clock);
}

export async function releaseTurnConnectionLease({ deviceId, connectionId, reason = 'released', clock = Date.now } = {}) {
  if (!trimString(connectionId)) throw Object.assign(new Error('Exact TURN reservation is required'), { statusCode: 400, code: 'turn_connection_id_required' });
  return mutateState((state) => {
    const normalizedDeviceId = trimString(deviceId);
    const normalizedConnectionId = trimString(connectionId);
    const leases = state.leases.filter((entry) => (
      entry.deviceId === normalizedDeviceId
      && entry.connectionId === normalizedConnectionId
      && isActiveLease(entry, clock())
    ));
    const timestamp = nowIso(clock);
    for (const lease of leases) {
      lease.status = 'released';
      lease.releasedAt = timestamp;
      lease.updatedAt = new Date(Math.max(clock(), turnLeaseObservedAt(lease))).toISOString();
      lease.releaseReason = trimString(reason).slice(0, 64);
    }
    return { released: leases.length, leaseIds: leases.map((entry) => entry.connectionId) };
  }, clock);
}
