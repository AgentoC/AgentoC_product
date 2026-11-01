// Minimal Slice-5 workflow API (design section 12):
//
//   POST /api/projects/:projectId/checkpoints   -- requestId idempotent
//   GET  /api/projects/:projectId/checkpoints   -- stable cursor pagination
//   POST /api/projects/:projectId/handoffs      -- reference-only handoff edge
//   POST /api/project-handoffs/:handoffId/accept -- atomic toProjectId bind
//
// Owner-gated; errors use the frozen §13 error codes + HTTP status mapping.
// System fields (git / usage / run state / execution scope) are never accepted
// from the client: the server re-reads canonical evidence from the Run store.
import {
  createProjectCheckpoint,
  listProjectCheckpoints,
} from './result-packets.mjs';
import {
  acceptHandoff,
  createHandoff,
} from './project-handoffs.mjs';
import { getProject, normalizeProjectId } from './projects.mjs';

const SYSTEM_FIELD_KEYS = new Set([
  'git', 'usage', 'runState', 'state', 'executionScope', 'executionScopeDigest',
  'provenance', 'digest', 'workspaceLease', 'manifest',
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stripSystemFields(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const next = { ...payload };
  for (const key of SYSTEM_FIELD_KEYS) delete next[key];
  return next;
}

function writeError(res, writeJson, error, fallback = 'Project workflow request failed') {
  const code = text(error?.code);
  const status = code.endsWith('NOT_FOUND') ? 404
    : ['WORKSPACE_LEASE_CONFLICT', 'HANDOFF_SUPERSEDED'].includes(code) ? 409 : 400;
  writeJson(res, status, {
    error: error?.message || fallback,
    ...(code ? { code } : {}),
  });
}

async function readJsonBody(req, readBody, maxBytes = 128 * 1024) {
  const body = await readBody(req, maxBytes);
  return body ? JSON.parse(body) : {};
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string');
}

export async function handleProjectWorkflowRoutes({
  req,
  res,
  pathname,
  query,
  authSession,
  readBody,
  writeJson,
}) {
  const normalizedPathname = text(pathname);
  const checkpointMatch = /^\/api\/projects\/([^/]+)\/checkpoints$/.exec(normalizedPathname);
  const handoffMatch = /^\/api\/projects\/([^/]+)\/handoffs$/.exec(normalizedPathname);
  const acceptMatch = /^\/api\/project-handoffs\/([^/]+)\/accept$/.exec(normalizedPathname);
  if (!checkpointMatch && !handoffMatch && !acceptMatch) return false;

  if (authSession?.role !== 'owner') {
    writeJson(res, 403, { error: 'Owner access required' });
    return true;
  }

  // ── POST /api/projects/:projectId/checkpoints ───────────────────────────
  if (checkpointMatch && req.method === 'POST') {
    const projectId = normalizeProjectId(decodeURIComponent(checkpointMatch[1]));
    if (!await requireProject(res, writeJson, projectId)) return true;
    let payload = {};
    try {
      payload = await readJsonBody(req, readBody);
    } catch (error) {
      writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid request body' });
      return true;
    }
    payload = stripSystemFields(payload);
    const requestId = text(payload.requestId);
    if (!requestId) {
      writeJson(res, 400, { error: 'requestId is required as the idempotency key', code: 'REQUEST_ID_REQUIRED' });
      return true;
    }
    try {
      const checkpoint = await createProjectCheckpoint({
        projectId,
        sessionIds: stringArray(payload.sessionIds),
        runIds: stringArray(payload.runIds),
        taskId: text(payload.taskId),
        attemptId: text(payload.attemptId),
        requestId,
      });
      writeJson(res, 201, { checkpoint });
    } catch (error) {
      writeError(res, writeJson, error, 'Failed to create checkpoint');
    }
    return true;
  }

  // ── GET /api/projects/:projectId/checkpoints ────────────────────────────
  if (checkpointMatch && req.method === 'GET') {
    const projectId = normalizeProjectId(decodeURIComponent(checkpointMatch[1]));
    if (!await requireProject(res, writeJson, projectId)) return true;
    try {
      const cursor = typeof query?.get === 'function' ? text(query.get('cursor')) : null;
      const rawLimit = typeof query?.get === 'function' ? Number.parseInt(query.get('limit'), 10) : NaN;
      const result = await listProjectCheckpoints(projectId, {
        cursor,
        limit: Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 20,
      });
      writeJson(res, 200, { checkpoints: result.checkpoints, nextCursor: result.nextCursor });
    } catch (error) {
      writeError(res, writeJson, error, 'Failed to list checkpoints');
    }
    return true;
  }

  // ── POST /api/projects/:projectId/handoffs ──────────────────────────────
  if (handoffMatch && req.method === 'POST') {
    const projectId = normalizeProjectId(decodeURIComponent(handoffMatch[1]));
    if (!await requireProject(res, writeJson, projectId)) return true;
    let payload = {};
    try {
      payload = await readJsonBody(req, readBody);
    } catch (error) {
      writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid request body' });
      return true;
    }
    payload = stripSystemFields(payload);
    const requestId = text(payload.requestId);
    if (!requestId) {
      writeJson(res, 400, { error: 'requestId is required as the idempotency key', code: 'REQUEST_ID_REQUIRED' });
      return true;
    }
    try {
      const handoff = await createHandoff({
        fromProjectId: projectId,
        toProjectId: text(payload.toProjectId),
        checkpointPacketId: text(payload.checkpointPacketId),
        requestId,
      });
      writeJson(res, 201, { handoff });
    } catch (error) {
      writeError(res, writeJson, error, 'Failed to create handoff');
    }
    return true;
  }

  // ── POST /api/project-handoffs/:handoffId/accept ────────────────────────
  if (acceptMatch && req.method === 'POST') {
    const handoffId = decodeURIComponent(acceptMatch[1]);
    let payload = {};
    try {
      payload = await readJsonBody(req, readBody);
    } catch (error) {
      writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid request body' });
      return true;
    }
    payload = stripSystemFields(payload);
    const requestId = text(payload.requestId);
    if (!requestId) {
      writeJson(res, 400, { error: 'requestId is required as the idempotency key', code: 'REQUEST_ID_REQUIRED' });
      return true;
    }
    try {
      const handoff = await acceptHandoff({
        handoffId,
        toProjectId: text(payload.toProjectId),
        requestId,
      });
      writeJson(res, 200, { handoff });
    } catch (error) {
      writeError(res, writeJson, error, 'Failed to accept handoff');
    }
    return true;
  }

  writeJson(res, 405, { error: 'Method not allowed' });
  return true;
}

async function requireProject(res, writeJson, projectId) {
  if (!projectId) {
    writeJson(res, 400, { error: 'projectId is required', code: 'PROJECT_ID_REQUIRED' });
    return false;
  }
  const project = await getProject(projectId).catch(() => null);
  if (!project) {
    writeJson(res, 404, { error: 'Project not found', code: 'PROJECT_NOT_FOUND' });
    return false;
  }
  return true;
}
