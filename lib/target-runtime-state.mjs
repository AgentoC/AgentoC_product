// Target-local revision and one-shot command ledger.
// The ledger contains no bearer or response body. Response replay is kept in
// memory by the request authenticator so a lost HTTP response can be retried
// during the short grant lifetime without persisting transcripts or secrets.
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { CONFIG_DIR } from './config.mjs';
import { createSerialTaskQueue, readJson, writeJsonAtomic } from '../chat/fs-utils.mjs';

export const TARGET_RUNTIME_STATE_FILE = join(CONFIG_DIR, 'target-runtime-state.json');
const STATE_SCHEMA_VERSION = 1;
const COMMAND_RETENTION_MS = 10 * 60 * 1000;
const MAX_COMMANDS = 2048;
const SUMMARY_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_SUMMARY_EVENTS = 4096;
const stateQueue = createSerialTaskQueue();

function text(value, max = 256) {
  return (typeof value === 'string' ? value.trim() : '').slice(0, max);
}

function integer(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function stateError(code, message, statusCode = 409, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function normalizeState(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const commands = Array.isArray(source.commands) ? source.commands : [];
  const summaryEvents = Array.isArray(source.summaryEvents) ? source.summaryEvents : [];
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    revision: integer(source.revision),
    snapshotDigest: text(source.snapshotDigest, 128),
    summaryCursor: integer(source.summaryCursor),
    commands: commands
      .filter((item) => item && typeof item === 'object' && text(item.requestId) && text(item.idempotencyKey))
      .map((item) => ({
        requestId: text(item.requestId, 160),
        idempotencyKey: text(item.idempotencyKey, 160),
        jti: text(item.jti, 160),
        sourceInstanceId: text(item.sourceInstanceId, 160),
        targetInstanceId: text(item.targetInstanceId, 160),
        method: text(item.method, 16).toUpperCase(),
        path: text(item.path, 2048),
        operation: text(item.operation, 96),
        resourceId: text(item.resourceId, 160),
        expectedRevision: integer(item.expectedRevision),
        status: text(item.status, 32) || 'completed',
        startedAt: text(item.startedAt, 64),
        completedAt: text(item.completedAt, 64),
      })),
    summaryEvents: summaryEvents
      .filter((item) => item && typeof item === 'object' && text(item.eventId) && text(item.targetId)
        && Number.isSafeInteger(Number(item.cursor)) && Number(item.cursor) > 0)
      .map((item) => ({
        eventId: text(item.eventId, 160),
        targetId: text(item.targetId, 160),
        instanceId: text(item.instanceId, 160),
        entityType: text(item.entityType, 64) || 'notification',
        entityId: text(item.entityId, 160) || text(item.targetId, 160),
        revision: integer(item.revision),
        type: text(item.type, 32) || 'snapshot',
        emittedAt: text(item.emittedAt, 64),
        cursor: integer(item.cursor),
        summary: item.summary && typeof item.summary === 'object' && !Array.isArray(item.summary)
          ? item.summary
          : {},
      })),
  };
}

async function readState(filePath = TARGET_RUNTIME_STATE_FILE) {
  return normalizeState(await readJson(filePath, null));
}

function prune(state, nowMs) {
  const commandCutoff = nowMs - COMMAND_RETENTION_MS;
  state.commands = state.commands.filter((item) => {
    const timestamp = Date.parse(item.completedAt || item.startedAt || '');
    return Number.isFinite(timestamp) && timestamp >= commandCutoff;
  }).slice(-MAX_COMMANDS);
  const summaryCutoff = nowMs - SUMMARY_EVENT_RETENTION_MS;
  state.summaryEvents = state.summaryEvents.filter((item) => {
    const timestamp = Date.parse(item.emittedAt || '');
    return Number.isFinite(timestamp) && timestamp >= summaryCutoff;
  }).slice(-MAX_SUMMARY_EVENTS);
}

function sameCommand(left, claims) {
  return left.requestId === text(claims.requestId, 160)
    && left.idempotencyKey === text(claims.idempotencyKey, 160)
    && left.jti === text(claims.jti, 160)
    && left.sourceInstanceId === text(claims.sourceInstanceId, 160)
    && left.targetInstanceId === text(claims.targetInstanceId, 160)
    && left.method === text(claims.method, 16).toUpperCase()
    && left.path === text(claims.path, 2048)
    && left.operation === text(claims.operation, 96)
    && left.resourceId === text(claims.resourceId, 160)
    && left.expectedRevision === integer(claims.expectedRevision);
}

export function isTargetRuntimeMutation(operation) {
  const normalized = text(operation, 96);
  return normalized !== 'runtime.summary' && !normalized.endsWith('.read');
}

export async function getTargetRuntimeState({ filePath = TARGET_RUNTIME_STATE_FILE } = {}) {
  return readState(filePath);
}

export async function getTargetRuntimeRevision(options = {}) {
  return (await readState(options.filePath)).revision;
}

function snapshotDigest(snapshot) {
  return createHash('sha256')
    .update(JSON.stringify(snapshot && typeof snapshot === 'object' ? snapshot : {}))
    .digest('hex');
}

/** Advance the target revision when the public summary projection changes. */
export async function recordTargetRuntimeSnapshot(snapshot, {
  filePath = TARGET_RUNTIME_STATE_FILE,
  nowMs = Date.now(),
} = {}) {
  const result = await recordTargetRuntimeSnapshotDetailed(snapshot, { filePath, nowMs });
  return result.revision;
}

export async function recordTargetRuntimeSnapshotDetailed(snapshot, {
  filePath = TARGET_RUNTIME_STATE_FILE,
  nowMs = Date.now(),
  targetId = '',
  instanceId = targetId,
  entityType = 'notification',
  entityId = targetId,
} = {}) {
  return stateQueue(async () => {
    const state = await readState(filePath);
    prune(state, nowMs);
    const digest = snapshotDigest(snapshot);
    if (state.snapshotDigest === digest) {
      return { revision: state.revision, cursor: state.summaryCursor, changed: false, event: null };
    }
    state.snapshotDigest = digest;
    state.revision += 1;
    state.summaryCursor += 1;
    const normalizedTargetId = text(targetId, 160);
    const normalizedInstanceId = text(instanceId, 160) || normalizedTargetId;
    const event = {
      eventId: `trse_${state.summaryCursor}_${digest.slice(0, 24)}`,
      targetId: normalizedTargetId,
      instanceId: normalizedInstanceId,
      entityType: text(entityType, 64) || 'notification',
      entityId: text(entityId, 160) || normalizedTargetId,
      revision: state.revision,
      type: 'snapshot',
      emittedAt: new Date(nowMs).toISOString(),
      cursor: state.summaryCursor,
      summary: snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {},
    };
    state.summaryEvents.push(event);
    state.summaryEvents = state.summaryEvents.slice(-MAX_SUMMARY_EVENTS);
    await writeJsonAtomic(filePath, state, { mode: 0o600 });
    return { revision: state.revision, cursor: state.summaryCursor, changed: true, event };
  });
}

export async function getTargetRuntimeSummaryEvents({
  filePath = TARGET_RUNTIME_STATE_FILE,
  afterCursor = 0,
  limit = 100,
} = {}) {
  const cursor = Number(afterCursor);
  const pageSize = Number(limit);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw stateError('TARGET_RUNTIME_CURSOR_INVALID', 'Summary event cursor is invalid.', 400);
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    throw stateError('TARGET_RUNTIME_LIMIT_INVALID', 'Summary event limit is invalid.', 400);
  }
  const state = await readState(filePath);
  const events = state.summaryEvents.filter((event) => event.cursor > cursor);
  const page = events.slice(0, pageSize);
  const nextCursor = page.length > 0 ? page.at(-1).cursor : cursor;
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    revision: state.revision,
    cursor: String(nextCursor),
    nextCursor: events.length > page.length ? String(nextCursor) : null,
    hasMore: events.length > page.length,
    events: page,
  };
}

export async function beginTargetRuntimeCommand(claims, {
  filePath = TARGET_RUNTIME_STATE_FILE,
  nowMs = Date.now(),
} = {}) {
  return stateQueue(async () => {
    const state = await readState(filePath);
    prune(state, nowMs);
    const existing = state.commands.find((item) => item.requestId === text(claims.requestId, 160)
      || (item.idempotencyKey === text(claims.idempotencyKey, 160)
        && item.targetInstanceId === text(claims.targetInstanceId, 160)));
    if (existing) {
      throw stateError(
        'TARGET_GRANT_REPLAYED',
        sameCommand(existing, claims)
          ? 'Target runtime grant was already used.'
          : 'Target runtime command binding was already used.',
        409,
      );
    }
    const expectedRevision = integer(claims.expectedRevision);
    if (isTargetRuntimeMutation(claims.operation) && expectedRevision !== state.revision) {
      throw stateError('TARGET_RUNTIME_REVISION_CONFLICT', 'Target runtime revision is stale.', 409, {
        expectedRevision,
        currentRevision: state.revision,
      });
    }
    const startedAt = new Date(nowMs).toISOString();
    state.commands.push({
      requestId: text(claims.requestId, 160),
      idempotencyKey: text(claims.idempotencyKey, 160),
      jti: text(claims.jti, 160),
      sourceInstanceId: text(claims.sourceInstanceId, 160),
      targetInstanceId: text(claims.targetInstanceId, 160),
      method: text(claims.method, 16).toUpperCase(),
      path: text(claims.path, 2048),
      operation: text(claims.operation, 96),
      resourceId: text(claims.resourceId, 160),
      expectedRevision,
      status: 'started',
      startedAt,
      completedAt: '',
    });
    await writeJsonAtomic(filePath, state, { mode: 0o600 });
    return { revision: state.revision, startedAt };
  });
}

export async function finishTargetRuntimeCommand(claims, {
  statusCode = 500,
  filePath = TARGET_RUNTIME_STATE_FILE,
  nowMs = Date.now(),
} = {}) {
  return stateQueue(async () => {
    const state = await readState(filePath);
    prune(state, nowMs);
    const command = state.commands.find((item) => sameCommand(item, claims));
    if (!command) return { revision: state.revision, committed: false };
    const succeeded = Number(statusCode) >= 200 && Number(statusCode) < 300;
    command.status = succeeded ? 'completed' : 'failed';
    command.completedAt = new Date(nowMs).toISOString();
    if (succeeded && isTargetRuntimeMutation(claims.operation)) state.revision += 1;
    await writeJsonAtomic(filePath, state, { mode: 0o600 });
    return { revision: state.revision, committed: succeeded };
  });
}
