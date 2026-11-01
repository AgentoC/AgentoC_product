import { join } from 'path';
import { mkdir, open, rm, stat } from 'fs/promises';
import { CHAT_HISTORY_DIR } from '../lib/config.mjs';
import { createKeyedTaskQueue, readJson, writeJsonAtomic } from './fs-utils.mjs';
import {
  assertContinuityProgress,
  buildContinuityCheckpoint,
  createContinuityReducer,
  migrateContinuityState,
  reduceContinuityEvents,
  validateContinuityState,
} from './continuity-core.mjs';

function normalizeLegacy(sessionId, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return migrateContinuityState(sessionId, value);
}

const CONTINUITY_LOCK_TIMEOUT_MS = 10_000;
const CONTINUITY_LOCK_STALE_MS = 30_000;

async function acquireContinuityLock(lockPath) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < CONTINUITY_LOCK_TIMEOUT_MS) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`, 'utf8');
      return async () => {
        await handle.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > CONTINUITY_LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const error = new Error(`continuity lock timeout: ${lockPath}`);
  error.code = 'CONTINUITY_LOCK_TIMEOUT';
  throw error;
}

export function createContinuityStore({ historyDir = CHAT_HISTORY_DIR } = {}) {
  const runSessionMutation = createKeyedTaskQueue();
  const pathFor = (sessionId) => join(historyDir, sessionId, 'continuity.json');

  async function read(sessionId) {
    const stored = normalizeLegacy(sessionId, await readJson(pathFor(sessionId), null));
    if (!stored) return null;
    validateContinuityState(stored);
    const path = pathFor(sessionId);
    const raw = await readJson(path, null);
    if (JSON.stringify(raw) !== JSON.stringify(stored)) {
      await writeJsonAtomic(path, stored, { spaces: 2 });
    }
    return stored;
  }

  async function write(sessionId, state, { expectedRevision = null } = {}) {
    return runSessionMutation(sessionId, async () => {
      const path = pathFor(sessionId);
      await mkdir(join(historyDir, sessionId), { recursive: true });
      const release = await acquireContinuityLock(`${path}.lock`);
      try {
        const current = await read(sessionId);
        const currentRevision = current?.revision || 0;
        if (expectedRevision !== null && currentRevision !== expectedRevision) {
          const error = new Error(`continuity CAS failed: expected ${expectedRevision}, got ${currentRevision}`);
          error.code = 'CONTINUITY_CAS_MISMATCH';
          throw error;
        }
        const checkpoint = buildContinuityCheckpoint(state);
        if (current) assertContinuityProgress(current, checkpoint);
        const withoutSaveTime = (value) => {
          const { savedAt: _savedAt, ...rest } = value;
          return rest;
        };
        if (current && current.revision === checkpoint.revision
          && JSON.stringify(withoutSaveTime(current)) === JSON.stringify(withoutSaveTime(checkpoint))) return current;
        await writeJsonAtomic(path, checkpoint, { spaces: 2 });
        return checkpoint;
      } finally {
        await release();
      }
    });
  }

  return { pathFor, read, write };
}

export const defaultContinuityStore = createContinuityStore();

export async function rebuildContinuityCheckpoint({
  sessionId,
  events = [],
  forEachEvent = null,
  store = defaultContinuityStore,
} = {}) {
  let state;
  if (typeof forEachEvent === 'function') {
    const reducer = createContinuityReducer(sessionId);
    await forEachEvent((event) => reducer.push(event));
    state = reducer.finish();
  } else {
    state = reduceContinuityEvents(sessionId, events);
  }
  if (state.coverage.omittedRanges.length > 0) {
    const error = new Error(`continuity history has omitted ranges for ${sessionId}`);
    error.code = 'CONTINUITY_HISTORY_GAP';
    error.omittedRanges = state.coverage.omittedRanges;
    throw error;
  }
  const previous = await store.read(sessionId);
  return store.write(sessionId, state, { expectedRevision: previous?.revision || 0 });
}
