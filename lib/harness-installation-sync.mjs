// Account-scoped Harness presence metadata.
//
// Harness installation itself is always local to a computer. The account
// directory receives only one versioned presence/tombstone per
// computer+Harness, so every UI can decide whether a globally synced Provider
// should be visible while never gaining a remote install/uninstall primitive.

import {
  getOwnerAccountBinding,
  listOwnerAccountDevices,
  publishOwnerAccountSyncCatalog,
} from './owner-account-auth.mjs';
import { loadOrCreateInstanceIdentity } from './instance-identity.mjs';
import { listHarnesses, listHarnessInstallationState } from './harness-registry.mjs';

export const HARNESS_INSTALLATION_SYNC_SCOPE = 'harness-installation';
const HARNESS_INSTALLATION_KEY_PREFIX = 'harness-installation|';
const LEGACY_DISCOVERY_VERSION = '1970-01-01T00:00:00.000Z';
const GLOBAL_STATUS_TTL_MS = 10_000;
const LOCAL_CATALOG_PUBLISH_TTL_MS = 10_000;

let globalStatusCache = null;
let localCatalogPublishedAt = 0;
let globalStatusRefreshPromise = null;
let localCatalogPublishPromise = null;

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedIso(value, fallback = LEGACY_DISCOVERY_VERSION) {
  const text = trim(value);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function normalizedCounter(value) {
  const counter = Number(value);
  return Number.isSafeInteger(counter) && counter >= 0 ? counter : 0;
}

export function harnessInstallationCatalogKey(instanceId, harnessId) {
  const source = trim(instanceId);
  const harness = trim(harnessId);
  if (!source || !harness) return '';
  return `${HARNESS_INSTALLATION_KEY_PREFIX}${source}|${harness}`;
}

export function parseHarnessInstallationCatalogKey(value) {
  const key = trim(value);
  if (!key.startsWith(HARNESS_INSTALLATION_KEY_PREFIX)) return null;
  const remainder = key.slice(HARNESS_INSTALLATION_KEY_PREFIX.length);
  const separator = remainder.lastIndexOf('|');
  if (separator <= 0 || separator === remainder.length - 1) return null;
  const instanceId = remainder.slice(0, separator).trim();
  const harnessId = remainder.slice(separator + 1).trim();
  return instanceId && harnessId ? { instanceId, harnessId } : null;
}

export function invalidateGlobalHarnessInstallationCache() {
  globalStatusCache = null;
  localCatalogPublishedAt = 0;
}

async function publishLocalHarnessInstallationCatalogInBackground(harnesses) {
  if (localCatalogPublishPromise) return localCatalogPublishPromise;
  localCatalogPublishPromise = publishLocalHarnessInstallationCatalog({ harnesses })
    .catch(() => null)
    .finally(() => {
      localCatalogPublishPromise = null;
    });
  localCatalogPublishPromise.then(() => {
    localCatalogPublishedAt = Date.now();
  }).catch(() => {});
  return localCatalogPublishPromise;
}

export function collectGloballyInstalledHarnessIds({
  localHarnessIds = [],
  syncCatalog = [],
  activeInstanceIds = null,
} = {}) {
  const installed = new Set((Array.isArray(localHarnessIds) ? localHarnessIds : [])
    .map(trim)
    .filter(Boolean));
  const activeSources = Array.isArray(activeInstanceIds)
    ? new Set(activeInstanceIds.map(trim).filter(Boolean))
    : null;
  for (const entry of Array.isArray(syncCatalog) ? syncCatalog : []) {
    if (entry?.scope !== HARNESS_INSTALLATION_SYNC_SCOPE || entry?.deletedAt) continue;
    const parsed = parseHarnessInstallationCatalogKey(entry.key);
    if (parsed?.harnessId && (!activeSources || activeSources.has(parsed.instanceId))) {
      installed.add(parsed.harnessId);
    }
  }
  return installed;
}

export async function listLocalHarnessInstallationCatalogEntries({
  sourceInstanceId,
  harnesses = null,
} = {}) {
  const source = trim(sourceInstanceId);
  if (!source) return [];
  const rows = Array.isArray(harnesses) ? harnesses : await listHarnesses();
  const state = await listHarnessInstallationState();
  return rows.flatMap((harness) => {
    const id = trim(harness?.id);
    if (!id || harness?.supportedOnPlatform === false) return [];
    const record = state[id] && typeof state[id] === 'object' ? state[id] : null;
    // A command found before lifecycle management existed is an installed
    // legacy Harness. A missing command with no explicit record is simply not
    // published; an explicit uninstall is published as a tombstone.
    if (!harness?.installed && !record) return [];
    const updatedAt = normalizedIso(record?.updatedAt);
    const entry = {
      scope: HARNESS_INSTALLATION_SYNC_SCOPE,
      key: harnessInstallationCatalogKey(source, id),
      version: {
        updatedAt,
        counter: normalizedCounter(record?.counter),
        writerId: source,
      },
    };
    return harness?.installed === true
      ? [entry]
      : [{ ...entry, deletedAt: updatedAt }];
  });
}

export async function publishLocalHarnessInstallationCatalog({
  sourceInstanceId = '',
  harnesses = null,
  fetchImpl = globalThis.fetch,
  clock = Date.now,
} = {}) {
  const source = trim(sourceInstanceId) || (await loadOrCreateInstanceIdentity()).instanceId;
  const entries = await listLocalHarnessInstallationCatalogEntries({ sourceInstanceId: source, harnesses });
  if (!entries.length) return { published: false, reason: 'no-local-harness-state', entries: [] };
  const result = await publishOwnerAccountSyncCatalog({ entries, fetchImpl, clock });
  invalidateGlobalHarnessInstallationCache();
  return { published: true, entries, ...result };
}

export async function getGloballyInstalledHarnessIds({
  localHarnesses = null,
  refresh = false,
  allowNetwork = true,
  fetchImpl = globalThis.fetch,
} = {}) {
  const localRows = Array.isArray(localHarnesses) ? localHarnesses : await listHarnesses();
  const installed = new Set(localRows.filter((harness) => harness?.installed === true).map((harness) => harness.id));
  const binding = await getOwnerAccountBinding();
  if (!binding?.accountId) return installed;
  const now = Date.now();
  if (!refresh
    && globalStatusCache
    && globalStatusCache.accountId === binding.accountId
    && now - globalStatusCache.at < GLOBAL_STATUS_TTL_MS) {
    return new Set([...installed, ...globalStatusCache.ids]);
  }
  if (!allowNetwork) {
    return new Set([
      ...installed,
      ...(globalStatusCache?.accountId === binding.accountId ? globalStatusCache.ids : []),
    ]);
  }
  try {
    const directory = await listOwnerAccountDevices({ fetchImpl });
    const activeInstanceIds = (Array.isArray(directory?.devices) ? directory.devices : [])
      .filter((device) => device?.deviceKind === 'computer' && !device?.unboundAt)
      .map((device) => device?.instanceId)
      .filter(Boolean);
    const remote = collectGloballyInstalledHarnessIds({
      syncCatalog: directory?.syncCatalog,
      activeInstanceIds,
    });
    globalStatusCache = { accountId: binding.accountId, at: Date.now(), ids: remote };
    return new Set([...installed, ...remote]);
  } catch {
    // The local Harness state remains authoritative for a private instance or
    // a temporarily unavailable Accounts directory. Never hide a local
    // runtime merely because the optional global index cannot be read.
    return installed;
  }
}

export function refreshHarnessInstallationCaches({ harnesses = null, fetchImpl = globalThis.fetch } = {}) {
  if (globalStatusRefreshPromise) return globalStatusRefreshPromise;
  globalStatusRefreshPromise = (async () => {
    const localRows = Array.isArray(harnesses) ? harnesses : await listHarnesses();
    if (Date.now() - localCatalogPublishedAt >= LOCAL_CATALOG_PUBLISH_TTL_MS) {
      await publishLocalHarnessInstallationCatalogInBackground(localRows);
      localCatalogPublishedAt = Date.now();
    }
    await getGloballyInstalledHarnessIds({ localHarnesses: localRows, refresh: true, fetchImpl });
  })().catch(() => null).finally(() => {
    globalStatusRefreshPromise = null;
  });
  globalStatusRefreshPromise.catch(() => {});
  return globalStatusRefreshPromise;
}

export async function decorateHarnessesForUi(harnesses = null, { refresh = false, fast = false } = {}) {
  const localRows = Array.isArray(harnesses) ? harnesses : await listHarnesses();
  if (fast && !refresh) {
    refreshHarnessInstallationCaches({ harnesses: localRows });
    const globalIds = await getGloballyInstalledHarnessIds({ localHarnesses: localRows, allowNetwork: false });
    return localRows.map((harness) => ({
      ...harness,
      installedOnThisComputer: harness.installed === true,
      globallyInstalled: globalIds.has(harness.id),
    }));
  }
  if (refresh || Date.now() - localCatalogPublishedAt >= LOCAL_CATALOG_PUBLISH_TTL_MS) {
    await publishLocalHarnessInstallationCatalog({ harnesses: localRows }).catch(() => {});
    localCatalogPublishedAt = Date.now();
  }
  const globalIds = await getGloballyInstalledHarnessIds({ localHarnesses: localRows, refresh });
  return localRows.map((harness) => ({
    ...harness,
    installedOnThisComputer: harness.installed === true,
    globallyInstalled: globalIds.has(harness.id),
  }));
}

export async function getGloballyInstalledHarnessIdsForProviders() {
  // Provider-picker reads are frequent and read-only. Reuse the short-lived
  // directory cache; local install/uninstall paths explicitly invalidate it.
  return getGloballyInstalledHarnessIds({ refresh: false });
}
