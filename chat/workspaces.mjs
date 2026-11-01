// Workspace identity store (Execution-Scope slice 1, design sections 5.1/5.2
// and migration section 11.1).
//
// Persists to chat-workspaces.json next to chat-projects.json:
//   {
//     "schemaVersion": 1,
//     "hostId": "host_...",
//     "workspaces": [
//       { id, hostId, rootPath, realRootPath, physicalKey, revision,
//         resolutionState: "resolved|unresolved", createdAt, updatedAt }
//     ]
//   }
//
// - hostId is a per-instance persistent random identity; generated on first
//   use and written to the file, stable across process restarts.
// - One Workspace per (hostId, physicalKey): different textual paths and
//   symlink aliases of the same realpath collapse to the same Workspace.
// - Missing/inaccessible roots produce resolutionState=unresolved without
//   throwing (migration scenario); a later ensure/resolve call can retry.
// - A resolved Workspace whose realpath differs from the recorded one raises
//   WORKSPACE_ROOT_DRIFT (409) instead of silently rebinding.
// - All writes are serialized through createSerialTaskQueue.
import { randomBytes } from 'crypto';
import { dirname, join } from 'path';

import { CHAT_PROJECTS_FILE } from '../lib/config.mjs';
import {
  createSerialTaskQueue,
  readJson,
  statOrNull,
  writeJsonAtomic,
} from './fs-utils.mjs';
import { isUnresolvableRootError, physicalKeyForPath, resolveRealRoot } from './execution-scope.mjs';

const WORKSPACES_FILE = join(dirname(CHAT_PROJECTS_FILE), 'chat-workspaces.json');
const WORKSPACE_STORE_SCHEMA_VERSION = 1;
const WORKSPACE_ID_PREFIX = 'ws_';
const HOST_ID_PREFIX = 'host_';

let hostIdCache = null;
let workspaceStoreCache = null;
let workspaceStoreCacheMtimeMs = null;
const workspaceMutation = createSerialTaskQueue();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStoredTimestamp(value, fallback = '') {
  const trimmed = trimString(value);
  if (!trimmed) return fallback;
  const time = Date.parse(trimmed);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function createWorkspaceError(message, code, statusCode, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

function normalizeWorkspaceRecord(entry, now) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const id = trimString(entry.id);
  const hostId = trimString(entry.hostId);
  const rootPath = trimString(entry.rootPath);
  const realRootPath = trimString(entry.realRootPath);
  const physicalKey = trimString(entry.physicalKey);
  if (!id || !hostId || !rootPath || !realRootPath || !physicalKey) return null;
  if (!id.startsWith(WORKSPACE_ID_PREFIX)) return null;
  return {
    id,
    hostId,
    rootPath,
    realRootPath,
    physicalKey,
    revision: Number.isInteger(entry.revision) && entry.revision > 0 ? entry.revision : 1,
    resolutionState: entry.resolutionState === 'unresolved' ? 'unresolved' : 'resolved',
    createdAt: normalizeStoredTimestamp(entry.createdAt, now),
    updatedAt: normalizeStoredTimestamp(entry.updatedAt, normalizeStoredTimestamp(entry.createdAt, now)),
  };
}

function normalizeWorkspaceStore(raw) {
  const now = new Date().toISOString();
  const rawWorkspaces = Array.isArray(raw?.workspaces) ? raw.workspaces : [];
  const hostId = trimString(raw?.hostId);
  const workspaces = [];
  const seenIds = new Set();
  const seenKeys = new Set();
  let changed = !raw || typeof raw !== 'object' || raw.schemaVersion !== WORKSPACE_STORE_SCHEMA_VERSION
    || !Array.isArray(raw.workspaces);
  for (const entry of rawWorkspaces) {
    const workspace = normalizeWorkspaceRecord(entry, now);
    if (!workspace) {
      changed = true;
      continue;
    }
    const key = `${workspace.hostId}\0${workspace.physicalKey}`;
    if (seenIds.has(workspace.id) || seenKeys.has(key)) {
      changed = true;
      continue;
    }
    seenIds.add(workspace.id);
    seenKeys.add(key);
    workspaces.push(workspace);
    if (JSON.stringify(entry) !== JSON.stringify(workspace)) changed = true;
  }
  return {
    store: {
      schemaVersion: WORKSPACE_STORE_SCHEMA_VERSION,
      hostId,
      workspaces,
    },
    changed,
  };
}

async function loadWorkspaceStoreUnlocked() {
  const stats = await statOrNull(WORKSPACES_FILE);
  if (!stats) {
    workspaceStoreCache = {
      schemaVersion: WORKSPACE_STORE_SCHEMA_VERSION,
      hostId: hostIdCache || '',
      workspaces: [],
    };
    workspaceStoreCacheMtimeMs = null;
    return workspaceStoreCache;
  }
  if (workspaceStoreCache && workspaceStoreCacheMtimeMs === stats.mtimeMs) {
    return workspaceStoreCache;
  }
  const parsed = await readJson(WORKSPACES_FILE, {
    schemaVersion: WORKSPACE_STORE_SCHEMA_VERSION,
    hostId: hostIdCache || '',
    workspaces: [],
  });
  const normalized = normalizeWorkspaceStore(parsed);
  workspaceStoreCache = normalized.store;
  if (normalized.changed) {
    await saveWorkspaceStoreUnlocked(workspaceStoreCache);
  } else {
    workspaceStoreCacheMtimeMs = stats.mtimeMs;
  }
  return workspaceStoreCache;
}

async function saveWorkspaceStoreUnlocked(store) {
  const normalized = normalizeWorkspaceStore(store).store;
  await writeJsonAtomic(WORKSPACES_FILE, normalized);
  workspaceStoreCache = normalized;
  workspaceStoreCacheMtimeMs = (await statOrNull(WORKSPACES_FILE))?.mtimeMs ?? null;
  if (normalized.hostId) hostIdCache = normalized.hostId;
  return workspaceStoreCache;
}

// Instance-persistent random identity; generated once and written into
// chat-workspaces.json, then fixed for the lifetime of the instance.
async function loadOrCreateHostIdUnlocked() {
  if (hostIdCache) return hostIdCache;
  const parsed = await readJson(WORKSPACES_FILE, {
    schemaVersion: WORKSPACE_STORE_SCHEMA_VERSION,
    hostId: '',
    workspaces: [],
  });
  const existing = trimString(parsed?.hostId);
  if (existing) {
    hostIdCache = existing;
    return existing;
  }
  const hostId = `${HOST_ID_PREFIX}${randomBytes(12).toString('hex')}`;
  await saveWorkspaceStoreUnlocked({
    schemaVersion: WORKSPACE_STORE_SCHEMA_VERSION,
    hostId,
    workspaces: Array.isArray(parsed?.workspaces) ? parsed.workspaces : [],
  });
  return hostId;
}

function replaceWorkspaceInStore(store, workspace) {
  const index = store.workspaces.findIndex((entry) => entry.id === workspace.id);
  if (index === -1) {
    store.workspaces.push(workspace);
  } else {
    store.workspaces[index] = workspace;
  }
  return workspace;
}

// Core resolution. Callers must be inside workspaceMutation (or be the
// internal backfill) so hostId generation and store writes stay serialized.
async function ensureWorkspaceForRootUnlocked(rootPath) {
  const normalizedInput = trimString(rootPath);
  if (!normalizedInput) {
    throw createWorkspaceError('rootPath is required', 'EINVAL', 400);
  }
  if (normalizedInput.includes('\0')) {
    throw createWorkspaceError('rootPath must not contain NUL bytes', 'EINVAL', 400);
  }
  const hostId = await loadOrCreateHostIdUnlocked();
  const store = await loadWorkspaceStoreUnlocked();

  let realRootPath = null;
  try {
    realRootPath = await resolveRealRoot(normalizedInput);
  } catch (error) {
    // Missing/inaccessible roots stay listable as unresolved (migration
    // scenario); unexpected failures still surface.
    if (!isUnresolvableRootError(error)) throw error;
  }

  if (realRootPath) {
    const physicalKey = physicalKeyForPath(hostId, realRootPath);
    const byKey = store.workspaces.find((entry) => entry.hostId === hostId && entry.physicalKey === physicalKey);
    if (byKey) {
      if (byKey.resolutionState === 'resolved') {
        // Defensive: the key is derived from the realpath, so a key match with
        // a different realpath can only happen on corrupted data.
        if (byKey.realRootPath !== realRootPath) {
          throw createWorkspaceError(
            'Workspace root drifted from the recorded physical identity',
            'WORKSPACE_ROOT_DRIFT',
            409,
            {
              workspaceId: byKey.id,
              recordedRealRootPath: byKey.realRootPath,
              currentRealRootPath: realRootPath,
            },
          );
        }
        return { ...byKey };
      }
      // A previously unresolved record now resolves: upgrade it in place.
      const resolved = {
        ...byKey,
        rootPath: normalizedInput,
        realRootPath,
        physicalKey,
        resolutionState: 'resolved',
        revision: byKey.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      replaceWorkspaceInStore(store, resolved);
      await saveWorkspaceStoreUnlocked(store);
      return { ...resolved };
    }
    // Same declared root path but a different physical identity: an existing
    // record for this hostId claims this root, so a realpath mismatch means
    // the root moved or was replaced -- never silently rebind. A still-
    // unresolved record (directory appeared since the last attempt) is
    // upgraded in place instead of creating a duplicate.
    const byText = store.workspaces.find((entry) => (
      entry.hostId === hostId
      && (entry.rootPath === normalizedInput || entry.realRootPath === normalizedInput)
    ));
    if (byText) {
      if (byText.resolutionState === 'resolved') {
        if (byText.realRootPath !== realRootPath) {
          throw createWorkspaceError(
            'Workspace root drifted from the recorded physical identity',
            'WORKSPACE_ROOT_DRIFT',
            409,
            {
              workspaceId: byText.id,
              recordedRealRootPath: byText.realRootPath,
              currentRealRootPath: realRootPath,
            },
          );
        }
        return { ...byText };
      }
      const resolved = {
        ...byText,
        rootPath: normalizedInput,
        realRootPath,
        physicalKey,
        resolutionState: 'resolved',
        revision: byText.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      replaceWorkspaceInStore(store, resolved);
      await saveWorkspaceStoreUnlocked(store);
      return { ...resolved };
    }
    const now = new Date().toISOString();
    const created = {
      id: `${WORKSPACE_ID_PREFIX}${randomBytes(12).toString('hex')}`,
      hostId,
      rootPath: normalizedInput,
      realRootPath,
      physicalKey,
      revision: 1,
      resolutionState: 'resolved',
      createdAt: now,
      updatedAt: now,
    };
    store.workspaces.push(created);
    await saveWorkspaceStoreUnlocked(store);
    return { ...created };
  }

  // Unresolved root: return/ensure an unresolved record without throwing.
  const byText = store.workspaces.find((entry) => (
    entry.hostId === hostId
    && entry.resolutionState === 'unresolved'
    && (entry.rootPath === normalizedInput || entry.realRootPath === normalizedInput)
  ));
  if (byText) return { ...byText };
  const now = new Date().toISOString();
  // Provisional key over the normalized text path: without a realpath we
  // cannot verify physical identity, so the key is text-based until the root
  // appears and the record is resolved/upgraded.
  const created = {
    id: `${WORKSPACE_ID_PREFIX}${randomBytes(12).toString('hex')}`,
    hostId,
    rootPath: normalizedInput,
    realRootPath: normalizedInput,
    physicalKey: physicalKeyForPath(hostId, normalizedInput),
    revision: 1,
    resolutionState: 'unresolved',
    createdAt: now,
    updatedAt: now,
  };
  store.workspaces.push(created);
  await saveWorkspaceStoreUnlocked(store);
  return { ...created };
}

/**
 * Ensure a Workspace exists for rootPath (creating or reusing the record for
 * this hostId + physicalKey). Missing/inaccessible roots return an unresolved
 * record instead of throwing; a resolved record whose realpath drifted raises
 * WORKSPACE_ROOT_DRIFT (409).
 */
export async function ensureWorkspaceForRoot(rootPath) {
  return workspaceMutation(() => ensureWorkspaceForRootUnlocked(rootPath));
}

/**
 * Explicit resolve retry for a specific Workspace. Returns null for unknown
 * ids; re-raises WORKSPACE_ROOT_DRIFT when a resolved root has moved.
 */
export async function resolveWorkspaceRoot(workspaceId) {
  const normalizedId = trimString(workspaceId);
  if (!normalizedId) return null;
  return workspaceMutation(async () => {
    const store = await loadWorkspaceStoreUnlocked();
    const existing = store.workspaces.find((entry) => entry.id === normalizedId);
    if (!existing) return null;
    return ensureWorkspaceForRootUnlocked(existing.rootPath);
  });
}

/**
 * Backfill scan over chat-projects.json: realpath() only the project root
 * itself, never walking the directory tree and never following symlinks inside
 * it. Missing roots become unresolved Workspaces. Does not write the project
 * store; returns one entry per project root with the resolved Workspace id.
 */
export async function backfillWorkspacesFromProjects() {
  return workspaceMutation(async () => {
    const parsed = await readJson(CHAT_PROJECTS_FILE, { schemaVersion: 1, projects: [] });
    const projects = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed?.projects) ? parsed.projects : []);
    const results = [];
    for (const project of projects) {
      const rootPath = trimString(project?.rootPath);
      if (!rootPath) continue;
      const workspace = await ensureWorkspaceForRootUnlocked(rootPath);
      results.push({
        projectId: trimString(project.id) || null,
        rootPath,
        workspaceId: workspace.id,
        resolutionState: workspace.resolutionState,
      });
    }
    return results;
  });
}

export async function getWorkspaceById(workspaceId) {
  const normalizedId = trimString(workspaceId);
  if (!normalizedId) return null;
  return workspaceMutation(async () => {
    const store = await loadWorkspaceStoreUnlocked();
    const found = store.workspaces.find((entry) => entry.id === normalizedId);
    return found ? { ...found } : null;
  });
}

export async function listWorkspaces() {
  return workspaceMutation(async () => {
    const store = await loadWorkspaceStoreUnlocked();
    return store.workspaces.map((entry) => ({ ...entry }));
  });
}
