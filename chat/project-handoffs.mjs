// ProjectHandoff edge store (Execution-Scope slice 5, design section 8.3).
//
// A handoff is an immutable reference edge `fromProject -> checkpointPacket ->
// toProject`. It never copies the checkpoint packet content; the bounded
// projection (summary / decisions / risks / acceptance + artifact & evidence
// refs) is computed on demand from the packet store.
//
// Persistence shares CONFIG_DIR/project-workflow.db with the packet store
// (node:sqlite + WAL). create and accept are idempotent under a requestId key;
// accept atomically binds toProjectId in a BEGIN IMMEDIATE transaction.
import { randomBytes } from 'crypto';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';

import { CONFIG_DIR } from '../lib/config.mjs';
import { createSerialTaskQueue } from './fs-utils.mjs';
import { getResultPacket } from './result-packets.mjs';
import { getProject } from './projects.mjs';

export const PROJECT_HANDOFF_SCHEMA_VERSION = 1;
export const HANDOFF_STATES = new Set(['prepared', 'accepted', 'superseded']);
const HANDOFF_ID_PREFIX = 'hof_';

const handoffMutation = createSerialTaskQueue();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowIso(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function createWorkflowError(message, code, statusCode = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

export function createHandoffId() {
  return `${HANDOFF_ID_PREFIX}${randomBytes(12).toString('hex')}`;
}

function dbPath() {
  return join(CONFIG_DIR, 'project-workflow.db');
}

function openDatabase() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const db = new DatabaseSync(dbPath(), { timeout: 10_000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS result_packets (
      packet_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('execution','project_checkpoint')),
      state TEXT NOT NULL,
      project_id TEXT NOT NULL,
      run_id TEXT,
      created_at TEXT NOT NULL,
      digest TEXT NOT NULL,
      packet_json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_result_packets_run ON result_packets(run_id) WHERE run_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_result_packets_project_kind ON result_packets(project_id, kind, created_at DESC, packet_id DESC);
    CREATE TABLE IF NOT EXISTS project_handoffs (
      handoff_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      from_project_id TEXT NOT NULL,
      to_project_id TEXT,
      checkpoint_packet_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','accepted','superseded')),
      created_at TEXT NOT NULL,
      accepted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_handoffs_from ON project_handoffs(from_project_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS workflow_idempotency (
      request_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

async function withDatabase(fn, { mutate = false } = {}) {
  const run = async () => {
    const db = openDatabase();
    try {
      return await fn(db);
    } finally {
      db.close();
    }
  };
  return mutate ? handoffMutation(run) : run();
}

function rowHandoff(row) {
  if (!row) return null;
  return {
    schemaVersion: PROJECT_HANDOFF_SCHEMA_VERSION,
    handoffId: row.handoff_id,
    fromProjectId: row.from_project_id,
    toProjectId: row.to_project_id || '',
    checkpointPacketId: row.checkpoint_packet_id,
    workspaceId: row.workspace_id,
    state: row.state,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at || null,
  };
}

function insertHandoffRow(db, handoff) {
  db.prepare(`
    INSERT INTO project_handoffs (
      handoff_id, schema_version, from_project_id, to_project_id,
      checkpoint_packet_id, workspace_id, state, created_at, accepted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    handoff.handoffId,
    PROJECT_HANDOFF_SCHEMA_VERSION,
    handoff.fromProjectId,
    trimString(handoff.toProjectId) || null,
    handoff.checkpointPacketId,
    handoff.workspaceId,
    handoff.state,
    handoff.createdAt,
    handoff.acceptedAt || null,
  );
}

/**
 * Create a prepared handoff edge referencing an existing project_checkpoint
 * packet. Only the reference is stored — the packet content is never copied.
 * Replaying the same requestId returns the same handoff.
 *
 * deps (test injection): { getProject, getResultPacket }
 */
export async function createHandoff({
  fromProjectId,
  toProjectId,
  checkpointPacketId,
  workspaceId,
  requestId,
  now,
  deps = {},
} = {}) {
  const normalizedFrom = trimString(fromProjectId);
  const normalizedCheckpoint = trimString(checkpointPacketId);
  if (!normalizedFrom || !normalizedCheckpoint) {
    throw createWorkflowError('fromProjectId and checkpointPacketId are required', 'EINVAL');
  }
  const normalizedRequestId = trimString(requestId);
  if (normalizedRequestId) {
    const replay = await withDatabase((db) => {
      const row = db.prepare(`
        SELECT result_json FROM workflow_idempotency
        WHERE request_id = ? AND kind = 'handoff-create'
      `).get(normalizedRequestId);
      return row ? row.result_json : null;
    });
    if (replay) return JSON.parse(replay);
  }

  const getPacket = typeof deps.getResultPacket === 'function' ? deps.getResultPacket : getResultPacket;
  const checkpoint = await getPacket(normalizedCheckpoint);
  if (!checkpoint) {
    throw createWorkflowError('Checkpoint packet not found', 'CHECKPOINT_NOT_FOUND', 404, {
      checkpointPacketId: normalizedCheckpoint,
    });
  }
  if (checkpoint.kind !== 'project_checkpoint') {
    throw createWorkflowError(
      'Handoffs must reference a project_checkpoint packet',
      'HANDOFF_INVALID_CHECKPOINT',
      400,
      { checkpointPacketId: normalizedCheckpoint, kind: checkpoint.kind },
    );
  }

  const loadProject = typeof deps.getProject === 'function' ? deps.getProject : getProject;
  const fromProject = await loadProject(normalizedFrom).catch(() => null);
  if (!fromProject) {
    throw createWorkflowError('Project not found', 'PROJECT_NOT_FOUND', 404, { projectId: normalizedFrom });
  }
  const normalizedWorkspaceId = trimString(workspaceId) || trimString(fromProject.workspaceId);
  if (!normalizedWorkspaceId) {
    throw createWorkflowError('workspaceId is required to create a handoff', 'EINVAL');
  }

  const handoff = {
    schemaVersion: PROJECT_HANDOFF_SCHEMA_VERSION,
    handoffId: createHandoffId(),
    fromProjectId: normalizedFrom,
    toProjectId: trimString(toProjectId),
    checkpointPacketId: normalizedCheckpoint,
    workspaceId: normalizedWorkspaceId,
    state: 'prepared',
    createdAt: nowIso(now),
    acceptedAt: null,
  };

  const stored = await withDatabase((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (normalizedRequestId) {
        const existing = db.prepare(`
          SELECT result_json FROM workflow_idempotency
          WHERE request_id = ? AND kind = 'handoff-create'
        `).get(normalizedRequestId);
        if (existing) {
          db.exec('COMMIT');
          return JSON.parse(existing.result_json);
        }
      }
      insertHandoffRow(db, handoff);
      if (normalizedRequestId) {
        db.prepare(`
          INSERT INTO workflow_idempotency (request_id, kind, target_id, result_json, created_at)
          VALUES (?, 'handoff-create', ?, ?, ?)
        `).run(normalizedRequestId, handoff.handoffId, JSON.stringify(handoff), handoff.createdAt);
      }
      db.exec('COMMIT');
      return handoff;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  });
  return stored;
}

/**
 * Atomically bind toProjectId and move the handoff to `accepted`. Idempotent
 * under both the requestId key and the handoff state: replaying the same
 * requestId — or accepting an already-accepted handoff — returns the same
 * result instead of failing. A superseded handoff cannot be accepted.
 */
export async function acceptHandoff({
  handoffId,
  toProjectId,
  requestId,
  now,
  deps = {},
} = {}) {
  const normalizedHandoffId = trimString(handoffId);
  const normalizedTarget = trimString(toProjectId);
  if (!normalizedHandoffId) {
    throw createWorkflowError('handoffId is required', 'EINVAL');
  }
  const normalizedRequestId = trimString(requestId);
  if (normalizedRequestId) {
    const replay = await withDatabase((db) => {
      const row = db.prepare(`
        SELECT result_json FROM workflow_idempotency
        WHERE request_id = ? AND kind = 'handoff-accept'
      `).get(normalizedRequestId);
      return row ? row.result_json : null;
    });
    if (replay) return JSON.parse(replay);
  }

  return withDatabase((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT * FROM project_handoffs WHERE handoff_id = ?').get(normalizedHandoffId);
      if (!row) {
        db.exec('COMMIT');
        throw createWorkflowError('Handoff not found', 'HANDOFF_NOT_FOUND', 404, { handoffId: normalizedHandoffId });
      }
      if (row.state === 'superseded') {
        db.exec('COMMIT');
        throw createWorkflowError(
          'A superseded handoff cannot be accepted',
          'HANDOFF_SUPERSEDED',
          409,
          { handoffId: normalizedHandoffId },
        );
      }
      const current = rowHandoff(row);
      if (current.state === 'accepted') {
        db.exec('COMMIT');
        return current;
      }
      const timestamp = nowIso(now);
      const accepted = {
        ...current,
        toProjectId: normalizedTarget,
        state: 'accepted',
        acceptedAt: timestamp,
      };
      db.prepare(`
        UPDATE project_handoffs
        SET to_project_id = ?, state = 'accepted', accepted_at = ?
        WHERE handoff_id = ?
      `).run(normalizedTarget || null, timestamp, normalizedHandoffId);
      if (normalizedRequestId) {
        db.prepare(`
          INSERT INTO workflow_idempotency (request_id, kind, target_id, result_json, created_at)
          VALUES (?, 'handoff-accept', ?, ?, ?)
        `).run(normalizedRequestId, normalizedHandoffId, JSON.stringify(accepted), timestamp);
      }
      db.exec('COMMIT');
      return accepted;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }, { mutate: true });
}

export async function getHandoff(handoffId, { deps = {} } = {}) {
  const normalized = trimString(handoffId);
  if (!normalized) return null;
  return withDatabase((db) => rowHandoff(
    db.prepare('SELECT * FROM project_handoffs WHERE handoff_id = ?').get(normalized),
  ));
}

export async function listHandoffsForProject(projectId, { deps = {} } = {}) {
  const normalized = trimString(projectId);
  if (!normalized) return [];
  return withDatabase((db) => db.prepare(
    'SELECT * FROM project_handoffs WHERE from_project_id = ? ORDER BY created_at DESC, handoff_id DESC',
  ).all(normalized).map(rowHandoff).filter(Boolean));
}

function evidenceRefsFromPacket(packet) {
  const refs = [];
  const push = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    for (const key of ['evidenceRef', 'ref', 'artifactRef', 'sourceRef', 'evidence']) {
      const value = entry[key];
      if (typeof value === 'string' && trimString(value)) refs.push(trimString(value));
    }
  };
  for (const entry of [...(packet.tests || []), ...(packet.acceptanceResults || [])]) push(entry);
  for (const artifact of packet.artifacts || []) {
    if (typeof artifact === 'string') refs.push(artifact);
    else if (artifact && typeof artifact === 'object') {
      for (const key of ['ref', 'id', 'name', 'path']) {
        const value = artifact[key];
        if (typeof value === 'string' && trimString(value)) refs.push(trimString(value));
      }
    }
  }
  return [...new Set(refs)];
}

/**
 * Bounded context projection for the next-stage Manager Session (design 8.3):
 * only summary / decisions / risks / acceptance, artifact & evidence refs and
 * the Workspace reference are injected — never the packet's full payload or
 * the previous Project's transcript.
 */
export async function buildHandoffProjection(handoffId, { deps = {} } = {}) {
  const handoff = await getHandoff(handoffId, { deps });
  if (!handoff) {
    throw createWorkflowError('Handoff not found', 'HANDOFF_NOT_FOUND', 404, { handoffId: trimString(handoffId) });
  }
  const getPacket = typeof deps.getResultPacket === 'function' ? deps.getResultPacket : getResultPacket;
  const packet = await getPacket(handoff.checkpointPacketId);
  return {
    handoff: {
      handoffId: handoff.handoffId,
      fromProjectId: handoff.fromProjectId,
      toProjectId: handoff.toProjectId,
      checkpointPacketId: handoff.checkpointPacketId,
      workspaceId: handoff.workspaceId,
      state: handoff.state,
      createdAt: handoff.createdAt,
      acceptedAt: handoff.acceptedAt,
    },
    packet: packet ? {
      packetId: packet.packetId,
      kind: packet.kind,
      state: packet.state,
      summary: packet.summary,
      decisions: packet.decisions || [],
      risks: packet.risks || [],
      acceptanceResults: packet.acceptanceResults || [],
      artifacts: (packet.artifacts || []).map((artifact) =>
        (typeof artifact === 'string' ? artifact : artifact?.ref || artifact?.id || artifact?.name || artifact?.path || '')),
      evidenceRefs: evidenceRefsFromPacket(packet),
    } : null,
    workspace: { workspaceId: handoff.workspaceId },
  };
}

/** Close pooled handles (used by tests). */
export async function closeProjectHandoffStore() {
  // node:sqlite connections are per-call; nothing to close.
  return true;
}
