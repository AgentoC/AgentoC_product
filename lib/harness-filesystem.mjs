import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { HARNESS_ROOT } from './harness-paths.mjs';

const transient = error => ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error?.code);
async function checkedRetiredRoot(root, { create = false } = {}) {
  if (resolve(root) !== resolve(HARNESS_ROOT)) throw new Error('Harness cleanup root is outside the owned prefix');
  const target = join(root, '.retired');
  if (create) await mkdir(target, { recursive: true, mode: 0o700 });
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(target) !== join(await realpath(root), '.retired')) {
    throw new Error('Harness cleanup directory must stay inside the owned prefix');
  }
  return target;
}
export function harnessInUseError(name) {
  return Object.assign(new Error(`${name} is in use or its files are locked. Finish its tasks and official login, then retry. No running process was stopped.`), {
    code: 'HARNESS_IN_USE', statusCode: 409,
  });
}

// Opening an image for write access (without writing any bytes) detects the
// Windows image-section lock before recursive removal can delete its shims.
// Never follow links into an external installation.
export async function assertHarnessFilesMutable(root, name, { platform = process.platform } = {}) {
  if (platform !== 'win32') return;
  let info;
  try { info = await lstat(root); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (info.isSymbolicLink()) throw new Error('Harness installation root must not be a symbolic link');
  const directories = [root];
  while (directories.length) {
    const directory = directories.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) directories.push(file);
      else if (entry.isFile() && /\.(exe|dll|node)$/i.test(entry.name)) {
        try { const handle = await open(file, 'r+'); await handle.close(); }
        catch (error) { if (transient(error) || error.code === 'ETXTBSY') throw harnessInUseError(name); if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
}

export async function retireHarnessDirectory(root, id, name, { renameImpl = rename } = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Invalid Harness identifier');
  const source = join(root, id);
  const retiredRoot = await checkedRetiredRoot(root, { create: true });
  const retiredPath = join(retiredRoot, `${id}-${randomUUID()}`);
  for (let attempt = 0; ; attempt++) {
    try { await renameImpl(source, retiredPath); return retiredPath; }
    catch (error) {
      if (error.code === 'ENOENT') return '';
      if (!transient(error)) throw error;
      if (attempt === 4) throw harnessInUseError(name);
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

export async function removeRetiredHarnessDirectory(retiredPath, { rmImpl = rm } = {}) {
  if (!retiredPath) return { filesRemoved: true, cleanupPending: false };
  try {
    const parent = await checkedRetiredRoot(HARNESS_ROOT);
    if (resolve(dirname(retiredPath)) !== resolve(parent) || !/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(basename(retiredPath))) {
      throw new Error('Invalid retired Harness path');
    }
    const info = await lstat(retiredPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isSymbolicLink()) throw new Error('Retired Harness directory must not be a symbolic link');
    await rmImpl(retiredPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    return { filesRemoved: true, cleanupPending: false };
  } catch (error) {
    // The runtime has already left its live path. Retain locked remnants for
    // later cleanup, never report an available half-removed installation.
    return { filesRemoved: false, cleanupPending: true, cleanupErrorCode: error.code || 'cleanup-failed' };
  }
}

let cleanupInFlight = null;
let nextCleanupAt = 0;
export function scheduleRetiredHarnessCleanup(root, ids) {
  if (cleanupInFlight || Date.now() < nextCleanupAt) return;
  nextCleanupAt = Date.now() + 60_000;
  cleanupInFlight = (async () => {
    const retiredRoot = await checkedRetiredRoot(root).catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    if (!retiredRoot) return;
    const entries = await readdir(retiredRoot, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const suffix = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const entry of entries.filter(entry => entry.isDirectory() && ids.some(id => entry.name.startsWith(`${id}-`) && suffix.test(entry.name.slice(id.length + 1)))).slice(0, 5)) {
      await removeRetiredHarnessDirectory(join(retiredRoot, entry.name));
    }
  })().catch(() => {}).finally(() => { cleanupInFlight = null; });
}
