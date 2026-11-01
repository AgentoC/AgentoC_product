import { readFile } from 'fs/promises';
import { join } from 'path';

import { CHAT_HISTORY_DIR } from '../lib/config.mjs';
import { writeJsonAtomic } from './fs-utils.mjs';

export const HISTORY_BASE_SCHEMA_VERSION = 1;
export const MAX_HISTORY_BASE_DEPTH = 32;

const baseCache = new Map();
const sourceLatestSeqCache = new Map();
const MAX_HISTORY_BASE_CACHE_ENTRIES = 512;

function setBoundedCacheValue(cache, key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_HISTORY_BASE_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function normalizedId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveOrZero(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function historyDir(sessionId) {
  return join(CHAT_HISTORY_DIR, sessionId);
}

export function historyBasePath(sessionId) {
  return join(historyDir(sessionId), 'history-base.json');
}

function invalidBase(message, code = 'HISTORY_BASE_INVALID') {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}

export function normalizeHistoryBase(value, { sessionId = '' } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sourceSessionId = normalizedId(value.sourceSessionId);
  const childSessionId = normalizedId(sessionId || value.childSessionId);
  const declaredChildSessionId = normalizedId(value.childSessionId);
  const throughSeq = positiveOrZero(value.throughSeq);
  const sourceThroughSeq = positiveOrZero(value.sourceThroughSeq ?? value.throughSeq);
  if (
    !sourceSessionId
    || !childSessionId
    || sourceSessionId === childSessionId
    || (declaredChildSessionId && declaredChildSessionId !== childSessionId)
  ) {
    throw invalidBase('history base has an invalid source or child session id');
  }
  if (throughSeq === null || sourceThroughSeq === null) {
    throw invalidBase('history base requires non-negative throughSeq values');
  }
  if (sourceThroughSeq !== throughSeq) {
    throw invalidBase('history base sourceThroughSeq must match throughSeq');
  }
  if (value.immutable === false) {
    throw invalidBase('history base must be immutable');
  }
  return {
    schemaVersion: HISTORY_BASE_SCHEMA_VERSION,
    childSessionId,
    sourceSessionId,
    throughSeq,
    sourceThroughSeq,
    sourceLatestSeqAtFork: positiveOrZero(value.sourceLatestSeqAtFork) ?? sourceThroughSeq,
    createdAt: typeof value.createdAt === 'string' && value.createdAt.trim()
      ? value.createdAt.trim()
      : new Date().toISOString(),
    immutable: true,
  };
}

export async function readHistoryBase(sessionId) {
  const normalizedSessionId = normalizedId(sessionId);
  if (!normalizedSessionId) return null;
  if (baseCache.has(normalizedSessionId)) {
    const cached = baseCache.get(normalizedSessionId);
    setBoundedCacheValue(baseCache, normalizedSessionId, cached);
    return cached;
  }
  const path = historyBasePath(normalizedSessionId);
  let raw;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      setBoundedCacheValue(baseCache, normalizedSessionId, null);
      return null;
    }
    throw invalidBase(`unable to read history base for ${normalizedSessionId}: ${error?.message || error}`);
  }
  if (raw === null) {
    setBoundedCacheValue(baseCache, normalizedSessionId, null);
    return null;
  }
  const normalized = normalizeHistoryBase(raw, { sessionId: normalizedSessionId });
  setBoundedCacheValue(baseCache, normalizedSessionId, normalized);
  return normalized;
}

export async function writeHistoryBase(sessionId, value) {
  const normalizedSessionId = normalizedId(sessionId);
  if (!normalizedSessionId) throw invalidBase('history base child session id is required');
  const normalized = normalizeHistoryBase(value, { sessionId: normalizedSessionId });
  const existing = await readHistoryBase(normalizedSessionId);
  if (existing) {
    const sameLineage = existing.sourceSessionId === normalized.sourceSessionId
      && existing.throughSeq === normalized.throughSeq
      && existing.sourceThroughSeq === normalized.sourceThroughSeq;
    if (!sameLineage) {
      throw invalidBase(
        `history base is immutable for ${normalizedSessionId}`,
        'HISTORY_BASE_IMMUTABLE',
      );
    }
    setBoundedCacheValue(baseCache, normalizedSessionId, existing);
    return existing;
  }
  await writeJsonAtomic(historyBasePath(normalizedSessionId), normalized, { spaces: 2 });
  setBoundedCacheValue(baseCache, normalizedSessionId, normalized);
  return normalized;
}

export function clearHistoryBaseCache(sessionId = '') {
  const normalizedSessionId = normalizedId(sessionId);
  if (normalizedSessionId) {
    baseCache.delete(normalizedSessionId);
    sourceLatestSeqCache.delete(normalizedSessionId);
  } else {
    baseCache.clear();
    sourceLatestSeqCache.clear();
  }
}

async function assertHistorySessionAvailable(sessionId, minimumSeq = 0) {
  const normalizedSessionId = normalizedId(sessionId);
  const requiredSeq = positiveOrZero(minimumSeq) ?? 0;
  const cachedLatestSeq = sourceLatestSeqCache.get(normalizedSessionId);
  if (Number.isInteger(cachedLatestSeq) && cachedLatestSeq >= requiredSeq) {
    setBoundedCacheValue(sourceLatestSeqCache, normalizedSessionId, cachedLatestSeq);
    return;
  }
  try {
    const meta = JSON.parse(await readFile(join(historyDir(normalizedSessionId), 'meta.json'), 'utf8'));
    const latestSeq = positiveOrZero(meta?.latestSeq);
    if (latestSeq === null || latestSeq < requiredSeq) {
      throw new Error(`latestSeq ${latestSeq ?? 'unknown'} is behind ${requiredSeq}`);
    }
    setBoundedCacheValue(sourceLatestSeqCache, normalizedSessionId, latestSeq);
  } catch {
    throw invalidBase(`history source session is unavailable: ${normalizedSessionId}`, 'HISTORY_BASE_UNAVAILABLE');
  }
}

export async function resolveHistoryEventSource(sessionId, seq, {
  maxDepth = MAX_HISTORY_BASE_DEPTH,
  // Batch history readers already loaded the child's base to validate the
  // request. Reuse it for the first hop instead of hitting the same cache and
  // promise boundary once per event; chained ancestors are still resolved
  // normally and remain subject to the existing depth/cycle checks.
  initialBase,
} = {}) {
  const normalizedSessionId = normalizedId(sessionId);
  if (!normalizedSessionId || !Number.isInteger(seq) || seq < 1) return null;
  let currentSessionId = normalizedSessionId;
  let currentSeq = seq;
  const visited = new Set();
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (visited.has(currentSessionId)) {
      throw invalidBase(`history base cycle detected at ${currentSessionId}`, 'HISTORY_BASE_CYCLE');
    }
    visited.add(currentSessionId);
    const base = depth === 0 && initialBase !== undefined
      ? initialBase
      : await readHistoryBase(currentSessionId);
    if (!base || currentSeq > base.throughSeq) {
      return { sessionId: currentSessionId, seq: currentSeq, depth };
    }
    if (currentSeq > base.sourceThroughSeq) {
      throw invalidBase(
        `history base cannot resolve seq ${currentSeq} from ${currentSessionId}`,
        'HISTORY_BASE_UNAVAILABLE',
      );
    }
    await assertHistorySessionAvailable(base.sourceSessionId, base.sourceThroughSeq);
    currentSessionId = base.sourceSessionId;
    currentSeq = Math.min(currentSeq, base.sourceThroughSeq);
  }
  throw invalidBase('history base chain exceeds the supported depth', 'HISTORY_BASE_DEPTH');
}

export async function resolveHistoryLineage(sessionId, { maxDepth = MAX_HISTORY_BASE_DEPTH } = {}) {
  const normalizedSessionId = normalizedId(sessionId);
  if (!normalizedSessionId) return [];
  const segments = [];
  let currentSessionId = normalizedSessionId;
  let upperSeq = Number.POSITIVE_INFINITY;
  const visited = new Set();
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (visited.has(currentSessionId)) {
      throw invalidBase(`history base cycle detected at ${currentSessionId}`, 'HISTORY_BASE_CYCLE');
    }
    visited.add(currentSessionId);
    const base = await readHistoryBase(currentSessionId);
    if (!base) {
      segments.push({ sessionId: currentSessionId, fromSeq: 1, toSeq: upperSeq });
      return segments.reverse();
    }
    segments.push({
      sessionId: currentSessionId,
      fromSeq: base.throughSeq + 1,
      toSeq: upperSeq,
    });
    await assertHistorySessionAvailable(base.sourceSessionId, base.sourceThroughSeq);
    upperSeq = Math.min(upperSeq, base.sourceThroughSeq);
    currentSessionId = base.sourceSessionId;
  }
  throw invalidBase('history base chain exceeds the supported depth', 'HISTORY_BASE_DEPTH');
}

export async function validateHistoryBaseChain(sessionId, options = {}) {
  return resolveHistoryLineage(sessionId, options);
}
