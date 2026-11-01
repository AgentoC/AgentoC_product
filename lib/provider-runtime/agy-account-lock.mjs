// Cross-process account lock for native AgY Runs.
//
// The lock is deliberately acquired before runner/provider preparation.  A
// queued Run must not copy an older rotating OAuth credential into its private
// HOME while another Run still owns the account.

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function agyAccountLockPath(configDir, providerId) {
  const key = createHash('sha256')
    .update(`agy-account:${trimString(providerId)}`)
    .digest('hex')
    .slice(0, 32);
  return join(configDir, 'native-provider-runtime', 'locks', `${key}.agy-account.lock`);
}

export function isRecoverableAgyAccountLockOwner(ownerRun, isTerminalRunState) {
  if (!ownerRun) return true;
  return typeof isTerminalRunState === 'function' && isTerminalRunState(ownerRun.state);
}

export async function listAgyAccountLocks({
  configDir,
  readdirImpl = readdir,
  readFileImpl = readFile,
} = {}) {
  const normalizedConfigDir = trimString(configDir);
  if (!normalizedConfigDir) return [];
  const locksDir = join(normalizedConfigDir, 'native-provider-runtime', 'locks');
  let entries;
  try {
    entries = await readdirImpl(locksDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const locks = [];
  for (const entry of entries) {
    if (!entry?.isFile?.() || !entry.name.endsWith('.agy-account.lock')) continue;
    const lockPath = join(locksDir, entry.name);
    let owner = null;
    try { owner = JSON.parse(await readFileImpl(lockPath, 'utf8')); } catch {}
    locks.push({ lockPath, owner });
  }
  return locks;
}

export async function releaseAgyAccountLock(configDir, providerId, options = {}) {
  // Keep the positional rm implementation supported for existing tests and
  // callers. New recovery callers use expected ownership to avoid deleting a
  // lock that changed hands between inspection and cleanup.
  const normalizedOptions = typeof options === 'function' ? { rmImpl: options } : (options || {});
  const {
    expectedRunId = '',
    expectedProviderId = '',
    readFileImpl = readFile,
    rmImpl = rm,
  } = normalizedOptions;
  const normalizedConfigDir = trimString(configDir);
  const normalizedProviderId = trimString(providerId);
  if (!normalizedConfigDir || !normalizedProviderId) return false;
  const lockPath = agyAccountLockPath(normalizedConfigDir, normalizedProviderId);
  const expectedRun = trimString(expectedRunId);
  const expectedProvider = trimString(expectedProviderId);
  if (expectedRun || expectedProvider) {
    let owner = null;
    try { owner = JSON.parse(await readFileImpl(lockPath, 'utf8')); } catch { return false; }
    if ((expectedRun && owner?.runId !== expectedRun)
      || (expectedProvider && owner?.providerId !== expectedProvider)) {
      return false;
    }
  }
  await rmImpl(lockPath, { force: true }).catch(() => {});
  return true;
}

export async function acquireAgyAccountLock({
  configDir,
  providerId,
  runId,
  mkdirImpl = mkdir,
  openImpl = open,
  readFileImpl = readFile,
  rmImpl = rm,
} = {}) {
  const normalizedConfigDir = trimString(configDir);
  const normalizedProviderId = trimString(providerId);
  const normalizedRunId = trimString(runId);
  if (!normalizedConfigDir || !normalizedProviderId || !normalizedRunId) {
    return { ok: false, reason: 'agy-account-lock-input-invalid' };
  }
  const lockPath = agyAccountLockPath(normalizedConfigDir, normalizedProviderId);
  await mkdirImpl(dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    const handle = await openImpl(lockPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({
      providerId: normalizedProviderId,
      runId: normalizedRunId,
      acquiredAt: new Date().toISOString(),
    })}\n`, 'utf8');
    return {
      ok: true,
      lockPath,
      release: async () => {
        await handle.close().catch(() => {});
        await rmImpl(lockPath, { force: true }).catch(() => {});
      },
    };
  } catch (error) {
    if (error?.code === 'EEXIST') {
      let owner = null;
      try { owner = JSON.parse(await readFileImpl(lockPath, 'utf8')); } catch {}
      // A restarted control plane may still own the lock for a live Run.  It
      // can adopt that ownership without replacing the file, preserving the
      // cross-process exclusion established by the original process.
      if (owner?.runId === normalizedRunId && owner?.providerId === normalizedProviderId) {
        return {
          ok: true,
          adopted: true,
          lockPath,
          release: async () => {
            await rmImpl(lockPath, { force: true }).catch(() => {});
          },
        };
      }
      return { ok: false, reason: 'agy-account-busy', lockPath, owner };
    }
    return { ok: false, reason: 'agy-account-lock-create-failed', lockPath };
  }
}
