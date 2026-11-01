// Persistent, instance-local AgY account rotation.
// The cursor is non-sensitive state. Credentials remain in SecretStore.
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { join } from 'path';

const ROTATION_VERSION = 1;
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 2_000;

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function eligible(profile) {
  return profile?.agentType === 'agy'
    && profile.enabled !== false
    && (!profile.status || profile.status === 'ready');
}

function normalizeIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(trim).filter(Boolean))];
}

function normalizeConfig(value) {
  return {
    version: ROTATION_VERSION,
    enabled: value?.enabled === true,
    providerIds: normalizeIds(value?.providerIds),
    cursor: Number.isInteger(value?.cursor) && value.cursor >= 0 ? value.cursor : 0,
    updatedAt: trim(value?.updatedAt) || null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createAgyRotationStore({
  configDir,
  readFileImpl = readFile,
  mkdirImpl = mkdir,
  renameImpl = rename,
  rmImpl = rm,
  now = () => new Date().toISOString(),
} = {}) {
  const dir = join(configDir, 'native-provider-runtime');
  const file = join(dir, 'agy-rotation.json');
  const lock = `${file}.lock`;

  async function read() {
    try {
      return normalizeConfig(JSON.parse(await readFileImpl(file, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return normalizeConfig(null);
      return normalizeConfig(null);
    }
  }

  async function write(config) {
    await mkdirImpl(dir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, { mode: 0o600 });
    await renameImpl(temp, file);
  }

  async function withLock(fn) {
    await mkdirImpl(dir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        await mkdirImpl(lock, { recursive: false, mode: 0o700 });
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST' || Date.now() >= deadline) {
          const lockError = new Error('AgY rotation state is busy');
          lockError.code = 'AGY_ROTATION_BUSY';
          throw lockError;
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
    try {
      return await fn();
    } finally {
      await rmImpl(lock, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function get() {
    return read();
  }

  async function update({ enabled, providerIds }, profiles = []) {
    const available = new Set(profiles.filter(eligible).map((profile) => profile.id));
    const ids = normalizeIds(providerIds);
    const invalid = ids.filter((id) => !available.has(id));
    if (invalid.length > 0) {
      const error = new Error(`AgY rotation contains unavailable provider: ${invalid.join(', ')}`);
      error.code = 'AGY_ROTATION_PROVIDER_INVALID';
      throw error;
    }
    return withLock(async () => {
      const current = await read();
      const next = {
        ...current,
        enabled: enabled === true,
        providerIds: ids,
        cursor: ids.length > 0 ? current.cursor % ids.length : 0,
        updatedAt: now(),
      };
      await write(next);
      return next;
    });
  }

  async function selectNext(profiles = []) {
    return withLock(async () => {
      const current = await read();
      if (!current.enabled || current.providerIds.length === 0) return null;
      const available = new Map(profiles.filter(eligible).map((profile) => [profile.id, profile]));
      const ids = current.providerIds.filter((id) => available.has(id));
      if (ids.length === 0) return null;
      const index = current.cursor % ids.length;
      const provider = available.get(ids[index]);
      await write({ ...current, cursor: (index + 1) % ids.length, updatedAt: now() });
      return provider;
    });
  }

  return { get, update, selectNext };
}
