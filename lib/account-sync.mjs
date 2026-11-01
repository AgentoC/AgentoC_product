// Shared metadata rules for decentralized account-owned configuration sync.
// This module contains no transport or credential handling. Accounts can use
// it to compare version metadata without importing the provider runtime.

export const ACCOUNT_SYNC_SCOPES = new Set([
  'provider',
  'agent-profile',
  'provider-credential',
  // Harness binaries remain device-local. This scope is metadata only: it
  // lets account-bound clients determine whether any computer has a Harness
  // installed without copying or remotely applying an installation.
  'harness-installation',
  // Account-level runtime policy (currently the account permission policy).
  // Metadata only: the payload is a small owner-controlled default that every
  // instance of the account applies locally.
  'runtime-policy',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeSyncScope(value, fallback = 'provider') {
  const scope = trimString(value).toLowerCase() || fallback;
  return ACCOUNT_SYNC_SCOPES.has(scope) ? scope : '';
}

function normalizeIso(value, fallback = '') {
  const text = trimString(value);
  if (!text) return fallback;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function normalizeCounter(value) {
  const counter = Number(value);
  return Number.isSafeInteger(counter) && counter >= 0 ? counter : 0;
}

export function normalizeSyncVersion(version, fallbackWriterId = '') {
  const source = version && typeof version === 'object' && !Array.isArray(version) ? version : {};
  return {
    updatedAt: normalizeIso(source.updatedAt),
    counter: normalizeCounter(source.counter),
    writerId: trimString(source.writerId) || trimString(fallbackWriterId),
  };
}

// The timestamp remains the primary human-readable ordering component. The
// local counter and writer id make concurrent same-clock writes deterministic.
export function compareSyncVersions(left, right) {
  const a = normalizeSyncVersion(left);
  const b = normalizeSyncVersion(right);
  const leftTime = Date.parse(a.updatedAt || '');
  const rightTime = Date.parse(b.updatedAt || '');
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.writerId.localeCompare(b.writerId);
}

export function normalizeSyncKey(value) {
  const key = trimString(value);
  if (!key || key.length > 256) throw new Error('Account sync record key is invalid.');
  return key;
}

export function syncRecordIdentity(scope, key) {
  const normalizedScope = normalizeSyncScope(scope);
  const normalizedKey = normalizeSyncKey(key);
  return `${normalizedScope}:${normalizedKey}`;
}

export function normalizeAccountSyncCatalogEntry(entry, fallbackSourceInstanceId = '') {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('Account sync catalog entry must be an object.');
  }
  const scope = normalizeSyncScope(entry.scope);
  const key = normalizeSyncKey(entry.key || entry.syncId);
  const version = normalizeSyncVersion(entry.version, entry.writerId);
  const sourceInstanceId = trimString(entry.sourceInstanceId || fallbackSourceInstanceId);
  if (!scope || !version.updatedAt || !version.writerId || !sourceInstanceId) {
    throw new Error('Account sync catalog entry is incomplete.');
  }
  return {
    scope,
    key,
    version,
    sourceInstanceId,
    ...(entry.deletedAt ? { deletedAt: normalizeIso(entry.deletedAt, version.updatedAt) } : {}),
  };
}

export function stableSyncValue(value) {
  if (Array.isArray(value)) return value.map((entry) => stableSyncValue(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableSyncValue(value[key])]),
  );
}

export function canonicalSyncJson(value) {
  return JSON.stringify(stableSyncValue(value));
}
