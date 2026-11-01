/** Authoritative, bounded Project routing context for one PC instance. */
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CONFIG_DIR } from '../lib/config.mjs';
import { loadOrCreateInstanceIdentity } from '../lib/instance-identity.mjs';
import { createSerialTaskQueue } from './fs-utils.mjs';
import { buildProjectFreshDelta } from './project-memory-engine.mjs';
import { defaultProjectMemoryStore } from './project-memory-store.mjs';
import { listProjectRecords } from './projects.mjs';
import { loadSessionsMeta } from './session-meta-store.mjs';
import { resolveWorkspaceRoot } from './workspaces.mjs';

const MAX_PROJECTS = 200;
const MAX_ACTIVE_THREADS = 5;
const MAX_SUMMARY_CHARS = 2_000;

function text(value, max = 0) {
  const valueText = typeof value === 'string' ? value.trim() : '';
  return max > 0 ? valueText.slice(0, max) : valueText;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeSearchText(value) {
  return text(value, 2_000).normalize('NFKC').toLocaleLowerCase();
}

function activeThreadsForProject(projectId, sessions) {
  const matching = sessions
    .filter((session) => session?.projectId === projectId
      && session.archived !== true && !session.internalRole && !session.visitorId)
    .sort((a, b) => text(b.updatedAt).localeCompare(text(a.updatedAt)));
  return {
    truncated: matching.length > MAX_ACTIVE_THREADS,
    threads: matching.slice(0, MAX_ACTIVE_THREADS).map((session) => ({
      sessionId: text(session.id, 160),
      title: text(session.name || session.title, 180),
      workflowState: text(session.workflowState, 80),
      activeRunId: text(session.activeRunId, 160),
      updatedAt: text(session.updatedAt, 80),
    })),
  };
}

function buildIndexEntry({ project, workspace, memory, freshDelta, sessions, targetInstanceId, checkedAt, memoryReadable }) {
  const active = activeThreadsForProject(project.id, sessions);
  const memorySummary = text(memory?.summary, MAX_SUMMARY_CHARS);
  const freshDeltaSummary = text(freshDelta, MAX_SUMMARY_CHARS);
  const hasWorkspace = workspace?.resolutionState === 'resolved';
  const identityHints = [
    { kind: 'project_name', value: text(project.name, 160) },
    { kind: 'root_path', value: text(project.rootPath, 2_000) },
  ].filter((hint) => hint.value);
  const entry = {
    schemaVersion: 1,
    targetInstanceId,
    projectId: project.id,
    projectRevision: Number(project.revision || 0),
    workspaceRevision: Number(workspace?.revision || 0),
    name: text(project.name, 160),
    purpose: text(project.purpose, 1_000),
    projectType: text(project.projectType, 80),
    workspaceId: text(project.workspaceId, 160),
    rootIdentity: text(workspace?.realRootPath || project.rootPath, 2_000),
    rootStatus: hasWorkspace ? 'resolved' : 'unresolved',
    identityHints,
    activeThreads: active.threads,
    memoryVersion: Number(memory?.currentVersion || 0),
    memorySummary,
    freshDeltaSummary,
    checkedAt,
    completeness: hasWorkspace && memoryReadable ? 'complete' : 'partial',
    truncated: active.truncated
      || text(memory?.summary).length > MAX_SUMMARY_CHARS
      || text(freshDelta).length > MAX_SUMMARY_CHARS,
    runtimeCapabilities: { projectIndex: true },
  };
  entry.sourceDigest = digest({
    project, workspace, memoryVersion: entry.memoryVersion,
    memorySummary, freshDeltaSummary, activeThreads: active.threads,
  });
  return entry;
}

/**
 * Each read rebuilds from the Project/Workspace/Session/Memory authorities.
 * SQLite keeps an inspectable revisioned projection, never a second source of
 * project identity. Authorization filtering happens after the complete read.
 */
export function createProjectIndex(options = {}) {
  const databasePath = options.databasePath || join(CONFIG_DIR, 'project-index.sqlite');
  const projects = options.listProjects || listProjectRecords;
  const sessions = options.loadSessions || loadSessionsMeta;
  const resolveWorkspace = options.resolveWorkspace || options.getWorkspace || resolveWorkspaceRoot;
  const instanceIdentity = options.getInstanceIdentity || loadOrCreateInstanceIdentity;
  const memoryStore = options.memoryStore || defaultProjectMemoryStore;
  const freshDeltaReader = options.readFreshDelta
    || ((projectId, version) => buildProjectFreshDelta(projectId, version, { store: memoryStore, record: false }));
  const serialize = createSerialTaskQueue();
  let memoryInitialized = false;

  async function open() {
    await mkdir(dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec(`CREATE TABLE IF NOT EXISTS project_index (
      target_instance_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      source_digest TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      entry_json TEXT NOT NULL,
      PRIMARY KEY (target_instance_id, project_id)
    )`);
    return db;
  }

  async function refresh({ allowedProjectIds = null, now = new Date() } = {}) {
    return serialize(async () => {
      const identity = await instanceIdentity();
      const targetInstanceId = text(identity?.instanceId, 160);
      if (!targetInstanceId) throw new Error('Project index requires a stable target instance identity');
      const [allProjects, allSessions] = await Promise.all([
        projects({ includeArchived: true }), sessions(),
      ]);
      if (!Array.isArray(allProjects) || !Array.isArray(allSessions)) {
        throw new Error('Project index source inventory is incomplete');
      }
      const activeProjects = allProjects.filter((project) => project?.archived !== true);
      const inventoryTruncated = activeProjects.length > MAX_PROJECTS;
      const selectedProjects = activeProjects.slice(0, MAX_PROJECTS);
      let memoryReadable = true;
      if (!memoryInitialized) {
        try { await memoryStore.initialize(); memoryInitialized = true; }
        catch { memoryReadable = false; }
      }
      const checkedAt = now.toISOString();
      const entries = [];
      for (const project of selectedProjects) {
        if (!project?.id || project.archived === true) continue;
        const workspace = project.workspaceId
          ? await resolveWorkspace(project.workspaceId).catch(() => null) : null;
        let memory = null;
        let freshDelta = '';
        if (memoryReadable) {
          try {
            memory = await memoryStore.getProjectMemory(project.id);
            freshDelta = await freshDeltaReader(project.id, memory?.currentVersion || 0);
          } catch {
            memoryReadable = false;
          }
        }
        entries.push(buildIndexEntry({
          project, workspace, memory, freshDelta, sessions: allSessions,
          targetInstanceId, checkedAt, memoryReadable,
        }));
      }
      const db = await open();
      try {
        db.exec('BEGIN IMMEDIATE');
        db.prepare('DELETE FROM project_index WHERE target_instance_id = ?').run(targetInstanceId);
        const insert = db.prepare(`INSERT INTO project_index
          (target_instance_id, project_id, source_digest, checked_at, entry_json)
          VALUES (?, ?, ?, ?, ?)`);
        for (const entry of entries) {
          insert.run(targetInstanceId, entry.projectId, entry.sourceDigest, checkedAt, JSON.stringify(entry));
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally { db.close(); }
      const allowed = allowedProjectIds == null ? null : new Set(allowedProjectIds);
      const visible = allowed ? entries.filter((entry) => allowed.has(entry.projectId)) : entries;
      return {
        schemaVersion: 1,
        targetInstanceId,
        checkedAt,
        inventoryComplete: !inventoryTruncated,
        truncated: inventoryTruncated,
        indexRevision: digest(visible.map((entry) => [entry.projectId, entry.sourceDigest])),
        projects: visible,
      };
    });
  }

  async function search({ query, allowedProjectIds = null, limit = 5 } = {}) {
    const context = await refresh({ allowedProjectIds });
    const needle = normalizeSearchText(query);
    if (!needle) return { ...context, candidates: [] };
    const tokens = needle.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1).slice(0, 12);
    const candidates = context.projects.map((project) => {
      const name = normalizeSearchText(project.name);
      const rootIdentity = normalizeSearchText(project.rootIdentity);
      const summary = normalizeSearchText(`${project.purpose} ${project.memorySummary} ${project.freshDeltaSummary}`);
      const threads = normalizeSearchText(project.activeThreads.map((thread) => thread.title).join(' '));
      const score = (needle.includes(normalizeSearchText(project.projectId)) ? 150 : 0)
        + (rootIdentity && needle.includes(rootIdentity) ? 120 : 0)
        + (needle === name ? 100 : 0)
        + (name.includes(needle) ? 30 : 0)
        + tokens.filter((token) => name.includes(token)).length * 10
        + tokens.filter((token) => summary.includes(token)).length * 3
        + tokens.filter((token) => threads.includes(token)).length;
      return { project, score };
    }).filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.project.projectId.localeCompare(b.project.projectId))
      .slice(0, Math.max(1, Math.min(Number(limit) || 5, 5)));
    return { ...context, candidates };
  }

  return { refresh, search };
}

export const defaultProjectIndex = createProjectIndex();
