import { readFile, rm } from 'fs/promises';
import { join } from 'path';

import { CHAT_HISTORY_DIR } from '../lib/config.mjs';
import {
  createInitialContinuityState,
  reduceContinuityEventsFromState,
} from './continuity-core.mjs';
import { writeJsonAtomic } from './fs-utils.mjs';

export const FORK_HISTORY_INDEX_SCHEMA_VERSION = 1;
export const FORK_HISTORY_INDEX_INTERVAL = 512;

function clone(value) {
  if (value === null || value === undefined) return value;
  return structuredClone(value);
}
export function forkHistoryIndexPath(sessionId) {
  return join(CHAT_HISTORY_DIR, sessionId, 'fork-history-index.json');
}

function timestampOf(event) {
  if (Number.isFinite(event?.timestamp)) return event.timestamp;
  const parsed = Date.parse(event?.timestamp || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function latestTimestamp(left, right) {
  const leftTime = Number.isFinite(left) ? left : Date.parse(left || '');
  const rightTime = Number.isFinite(right) ? right : Date.parse(right || '');
  if (!Number.isFinite(leftTime)) return Number.isFinite(rightTime) ? rightTime : null;
  if (!Number.isFinite(rightTime)) return leftTime;
  return Math.max(leftTime, rightTime);
}

function isActivityEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.type !== 'approval_response') return true;
  const source = typeof event.source === 'string' ? event.source.trim() : '';
  return source !== 'boot-backfill' && source !== 'run-finalize';
}

function assistantTimestamp(current, event) {
  if (event?.type !== 'message' || event.role !== 'assistant') return current || null;
  return timestampOf(event) || current || null;
}

export function createForkHistoryStats() {
  return {
    latestSeq: 0,
    size: 0,
    lastEventAt: null,
    lastActivityAt: null,
    lastAssistantMessageAt: null,
    counts: {},
  };
}

export function applyForkHistoryStats(stats, event) {
  const next = {
    ...createForkHistoryStats(),
    ...(stats || {}),
    counts: { ...(stats?.counts || {}) },
  };
  const seq = Number.isInteger(event?.seq) && event.seq > 0 ? event.seq : next.latestSeq + 1;
  const timestamp = timestampOf(event);
  next.latestSeq = Math.max(next.latestSeq, seq);
  next.size += 1;
  next.lastEventAt = timestamp || next.lastEventAt;
  if (isActivityEvent(event)) next.lastActivityAt = latestTimestamp(next.lastActivityAt, timestamp);
  next.lastAssistantMessageAt = assistantTimestamp(next.lastAssistantMessageAt, event);
  if (event?.type) next.counts[event.type] = (next.counts[event.type] || 0) + 1;
  if (event?.type === 'message' && event.role === 'user') {
    next.counts.message_user = (next.counts.message_user || 0) + 1;
  }
  if (event?.type === 'message' && event.role === 'assistant') {
    next.counts.message_assistant = (next.counts.message_assistant || 0) + 1;
  }
  return next;
}

function normalizeStats(value) {
  const stats = createForkHistoryStats();
  if (!value || typeof value !== 'object') return stats;
  return {
    ...stats,
    ...value,
    latestSeq: Number.isInteger(value.latestSeq) && value.latestSeq >= 0 ? value.latestSeq : 0,
    size: Number.isInteger(value.size) && value.size >= 0 ? value.size : 0,
    counts: { ...(value.counts || {}) },
  };
}

function normalizeCheckpoint(value) {
  if (!value || typeof value !== 'object') return null;
  const throughSeq = Number.isInteger(value.throughSeq) && value.throughSeq >= 0
    ? value.throughSeq
    : 0;
  return {
    throughSeq,
    stats: normalizeStats(value.stats),
    continuity: value.continuity && typeof value.continuity === 'object'
      ? clone(value.continuity)
      : null,
  };
}

export function normalizeForkHistoryIndex(value, { sessionId = '' } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schemaVersion !== FORK_HISTORY_INDEX_SCHEMA_VERSION) return null;
  const checkpoints = (Array.isArray(value.checkpoints) ? value.checkpoints : [])
    .map(normalizeCheckpoint)
    .filter(Boolean)
    .sort((left, right) => left.throughSeq - right.throughSeq);
  return {
    schemaVersion: FORK_HISTORY_INDEX_SCHEMA_VERSION,
    sessionId: typeof sessionId === 'string' && sessionId.trim()
      ? sessionId.trim()
      : String(value.sessionId || '').trim(),
    interval: Number.isInteger(value.interval) && value.interval > 0 ? value.interval : FORK_HISTORY_INDEX_INTERVAL,
    builtThroughSeq: Number.isInteger(value.builtThroughSeq) && value.builtThroughSeq >= 0
      ? value.builtThroughSeq
      : (checkpoints.at(-1)?.throughSeq || 0),
    sourceLatestSeq: Number.isInteger(value.sourceLatestSeq) && value.sourceLatestSeq >= 0
      ? value.sourceLatestSeq
      : (checkpoints.at(-1)?.throughSeq || 0),
    complete: value.complete === true,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    checkpoints,
  };
}

export async function readForkHistoryIndex(sessionId) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) return null;
  try {
    const parsed = JSON.parse(await readFile(forkHistoryIndexPath(normalizedSessionId), 'utf8'));
    return normalizeForkHistoryIndex(parsed, { sessionId: normalizedSessionId });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    const invalid = new Error(`unable to read fork history index for ${normalizedSessionId}: ${error?.message || error}`);
    invalid.code = 'FORK_HISTORY_INDEX_INVALID';
    throw invalid;
  }
}

export async function writeForkHistoryIndex(sessionId, value) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  const normalized = normalizeForkHistoryIndex(value, { sessionId: normalizedSessionId });
  if (!normalized) throw new Error('invalid fork history index');
  normalized.updatedAt = new Date().toISOString();
  await writeJsonAtomic(forkHistoryIndexPath(normalizedSessionId), normalized, { spaces: 0 });
  return normalized;
}

export async function removeForkHistoryIndex(sessionId) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) return false;
  try {
    await rm(forkHistoryIndexPath(normalizedSessionId), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function getForkHistoryCheckpoint(index, throughSeq) {
  const target = Number.isInteger(throughSeq) && throughSeq >= 0 ? throughSeq : 0;
  if (!index || index.complete !== true || index.builtThroughSeq < target) return null;
  let result = null;
  for (const checkpoint of index.checkpoints || []) {
    if (checkpoint.throughSeq > target) break;
    result = checkpoint;
  }
  return result ? clone(result) : null;
}

export async function buildForkHistoryIndex({
  sessionId,
  latestSeq = 0,
  forEachEvent,
  interval = FORK_HISTORY_INDEX_INTERVAL,
  existingIndex = null,
} = {}) {
  if (typeof forEachEvent !== 'function') throw new TypeError('forEachEvent is required');
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  const targetLatestSeq = Number.isInteger(latestSeq) && latestSeq >= 0 ? latestSeq : 0;
  if (!normalizedSessionId || targetLatestSeq === 0) {
    return {
      schemaVersion: FORK_HISTORY_INDEX_SCHEMA_VERSION,
      sessionId: normalizedSessionId,
      interval,
      builtThroughSeq: 0,
      sourceLatestSeq: 0,
      complete: true,
      updatedAt: new Date().toISOString(),
      checkpoints: [],
    };
  }

  const baseIndex = existingIndex !== null
    ? existingIndex
    : await readForkHistoryIndex(normalizedSessionId).catch(() => null);

  let stats = createForkHistoryStats();
  let continuity = createInitialContinuityState(normalizedSessionId);
  let checkpoints = [];
  let previousSeq = 0;

  if (
    baseIndex
    && baseIndex.schemaVersion === FORK_HISTORY_INDEX_SCHEMA_VERSION
    && baseIndex.interval === interval
    && Array.isArray(baseIndex.checkpoints)
    && baseIndex.checkpoints.length > 0
  ) {
    const validCheckpoints = [];
    let expectedCheckpointSeq = interval;
    for (const cp of baseIndex.checkpoints) {
      if (
        cp
        && Number.isInteger(cp.throughSeq)
        && cp.throughSeq > 0
        && cp.throughSeq <= targetLatestSeq
        && cp.stats
        && cp.continuity
      ) {
        if (cp.throughSeq === expectedCheckpointSeq) {
          validCheckpoints.push(cp);
          expectedCheckpointSeq += interval;
        } else if (cp.throughSeq === targetLatestSeq) {
          validCheckpoints.push(cp);
          break;
        }
      }
    }

    if (validCheckpoints.length > 0) {
      const lastCp = validCheckpoints.at(-1);
      checkpoints = validCheckpoints.map((cp) => ({
        throughSeq: cp.throughSeq,
        stats: clone(cp.stats),
        continuity: clone(cp.continuity),
      }));
      previousSeq = lastCp.throughSeq;
      stats = clone(lastCp.stats);
      continuity = clone(lastCp.continuity);
    }
  }

  if (previousSeq === targetLatestSeq) {
    return {
      schemaVersion: FORK_HISTORY_INDEX_SCHEMA_VERSION,
      sessionId: normalizedSessionId,
      interval,
      builtThroughSeq: targetLatestSeq,
      sourceLatestSeq: targetLatestSeq,
      complete: true,
      updatedAt: new Date().toISOString(),
      checkpoints,
    };
  }

  const chunk = [];
  const saveCheckpoint = (throughSeq) => {
    if (throughSeq <= 0 || checkpoints.at(-1)?.throughSeq === throughSeq) return;
    checkpoints.push({
      throughSeq,
      stats: clone(stats),
      continuity: clone(continuity),
    });
  };

  const options = {
    ...(previousSeq > 0 ? { fromSeq: previousSeq + 1 } : {}),
    toSeq: targetLatestSeq,
  };

  await forEachEvent(async (event) => {
    if (!event || !Number.isInteger(event.seq) || event.seq <= 0 || event.seq > targetLatestSeq) return;
    if (event.seq <= previousSeq) return;
    if (event.seq !== previousSeq + 1) {
      const gap = new Error(`fork history index encountered a gap before seq ${event.seq}`);
      gap.code = 'FORK_HISTORY_INDEX_GAP';
      throw gap;
    }
    previousSeq = event.seq;
    stats = applyForkHistoryStats(stats, event);
    chunk.push(event);
    if (event.seq % interval === 0) {
      continuity = reduceContinuityEventsFromState(normalizedSessionId, continuity, chunk);
      chunk.length = 0;
      saveCheckpoint(event.seq);
    }
  }, options);

  if (previousSeq !== targetLatestSeq) {
    const gap = new Error(`fork history index is incomplete at seq ${previousSeq}; expected ${targetLatestSeq}`);
    gap.code = 'FORK_HISTORY_INDEX_INCOMPLETE';
    throw gap;
  }
  if (chunk.length > 0) {
    continuity = reduceContinuityEventsFromState(normalizedSessionId, continuity, chunk);
    chunk.length = 0;
  }
  saveCheckpoint(targetLatestSeq);
  return {
    schemaVersion: FORK_HISTORY_INDEX_SCHEMA_VERSION,
    sessionId: normalizedSessionId,
    interval,
    builtThroughSeq: targetLatestSeq,
    sourceLatestSeq: targetLatestSeq,
    complete: true,
    updatedAt: new Date().toISOString(),
    checkpoints,
  };
}

export async function completeForkHistoryPrefixSnapshot({
  index,
  throughSeq = 0,
  forEachEvent,
  sessionId = '',
} = {}) {
  const target = Number.isInteger(throughSeq) && throughSeq >= 0 ? throughSeq : 0;
  if (target === 0) {
    return { stats: createForkHistoryStats(), continuity: createInitialContinuityState(sessionId), throughSeq: 0 };
  }
  const checkpoint = getForkHistoryCheckpoint(index, target);
  if (!checkpoint) return null;
  let stats = checkpoint.stats;
  let continuity = checkpoint.continuity || createInitialContinuityState(sessionId);
  if (checkpoint.throughSeq === target) return { stats, continuity, throughSeq: target };
  if (typeof forEachEvent !== 'function') return null;
  const suffix = [];
  await forEachEvent((event) => {
    suffix.push(event);
  }, { fromSeq: checkpoint.throughSeq + 1, toSeq: target });
  for (const event of suffix) {
    stats = applyForkHistoryStats(stats, event);
  }
  continuity = reduceContinuityEventsFromState(sessionId, continuity, suffix);
  if (stats.latestSeq !== target) return null;
  return { stats, continuity, throughSeq: target };
}
