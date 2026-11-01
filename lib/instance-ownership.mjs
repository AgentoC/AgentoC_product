import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export const INSTANCE_OWNERSHIP_ALREADY_ACTIVE = 'INSTANCE_OWNERSHIP_ALREADY_ACTIVE';
export const INSTANCE_OWNERSHIP_MISMATCH = 'INSTANCE_OWNERSHIP_MISMATCH';
export const INSTANCE_OWNERSHIP_INVALID = 'INSTANCE_OWNERSHIP_INVALID';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOwner({ instanceId, endpointName, pid, token, startedAt }) {
  const normalizedInstanceId = trimString(instanceId);
  const normalizedEndpointName = trimString(endpointName);
  if (!normalizedInstanceId || !normalizedEndpointName || !Number.isInteger(pid) || pid <= 0) {
    const error = new Error('instance ownership requires instanceId, endpointName, and a positive pid');
    error.code = INSTANCE_OWNERSHIP_INVALID;
    throw error;
  }
  return {
    version: 1,
    instanceId: normalizedInstanceId,
    endpointName: normalizedEndpointName,
    pid,
    token: trimString(token) || randomUUID(),
    startedAt: trimString(startedAt) || new Date().toISOString(),
  };
}

function sameOwner(left, right) {
  return Boolean(left && right)
    && left.version === right.version
    && left.instanceId === right.instanceId
    && left.endpointName === right.endpointName
    && left.pid === right.pid
    && left.token === right.token;
}

async function readOwner(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

async function readOwnershipMarker(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return { exists: true, owner: parsed && typeof parsed === 'object' ? parsed : null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, owner: null };
    return { exists: true, owner: null };
  }
}

/**
 * Acquire an instance ownership marker using O_EXCL. Existing markers are
 * never removed or judged stale here: a new process cannot prove that a PID
 * was not reused, so startup fails closed until an owner releases its marker.
 */
export async function acquireInstanceOwnership({
  filePath,
  instanceId,
  endpointName,
  pid = process.pid,
  token,
  startedAt,
} = {}) {
  const normalizedFilePath = trimString(filePath);
  if (!normalizedFilePath) {
    const error = new Error('instance ownership requires filePath');
    error.code = INSTANCE_OWNERSHIP_INVALID;
    throw error;
  }
  const owner = normalizeOwner({ instanceId, endpointName, pid, token, startedAt });
  await mkdir(dirname(normalizedFilePath), { recursive: true });
  let handle;
  try {
    handle = await open(normalizedFilePath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error?.code === 'EEXIST') {
      const activeMarker = await readOwnershipMarker(normalizedFilePath);
      const wrapped = new Error(`instance endpoint is already owned: ${endpointName}`);
      wrapped.code = INSTANCE_OWNERSHIP_ALREADY_ACTIVE;
      wrapped.owner = activeMarker.owner;
      // A malformed or unreadable marker is deliberately indistinguishable
      // from a live owner for admission purposes.  PID reuse means a new
      // process cannot safely "repair" it during startup.
      wrapped.markerState = activeMarker.owner ? 'owned' : 'unverified';
      throw wrapped;
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }

  let releasePromise = null;
  const release = ({ removeEndpoint } = {}) => {
    if (releasePromise) return releasePromise;
    const pendingRelease = (async () => {
      const current = await readOwner(normalizedFilePath);
      if (!sameOwner(current, owner)) {
        const error = new Error('instance ownership marker is not owned by this process');
        error.code = INSTANCE_OWNERSHIP_MISMATCH;
        throw error;
      }
      if (typeof removeEndpoint === 'function') await removeEndpoint({ ...owner });
      await rm(normalizedFilePath, { force: false });
      return { ok: true, owner };
    })();
    releasePromise = pendingRelease;
    // A failed endpoint cleanup must remain retryable. Keep the single-flight
    // guard only for a successful release, otherwise a transient cleanup
    // failure would strand the marker until manual intervention.
    pendingRelease.catch(() => {
      if (releasePromise === pendingRelease) releasePromise = null;
    });
    return releasePromise;
  };

  return {
    ...owner,
    filePath: normalizedFilePath,
    release,
  };
}

export async function readInstanceOwnership(filePath) {
  return readOwner(filePath);
}

export function isInstanceOwnershipMatch(owner, candidate) {
  return sameOwner(owner, candidate);
}
