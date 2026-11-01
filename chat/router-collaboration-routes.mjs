import {
  dispatchValidatedCollaborationPlan,
  getValidatedCollaborationPlan,
  validateCollaborationPlanTool,
} from './orchestration-tools.mjs';
import { getExecutionByScope } from './orchestration-store.mjs';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pathParts(pathname) {
  return String(pathname || '').split('/').filter(Boolean);
}

function writeError(res, writeJson, error, fallback = 'Collaboration request failed') {
  const code = text(error?.code);
  const status = error?.statusCode || (code.endsWith('NOT_FOUND') ? 404
    : ['COLLABORATION_POLICY_DENIED', 'COLLABORATION_AGENT_DENIED', 'COLLABORATION_ROLE_DENIED'].includes(code) ? 403
      : ['COLLABORATION_CONFLICT', 'COLLABORATION_AGENT_ROLE_MISMATCH', 'COLLABORATION_CAPABILITY_DENIED', 'COLLABORATION_POLICY_REVISION_MISMATCH', 'COLLABORATION_NOT_RETRYABLE', 'COLLABORATION_PROJECT_REQUIRED', 'COLLABORATION_PROJECT_MISMATCH', 'COLLABORATION_VALIDATION_EXPIRED', 'READ_ONLY_RUNTIME_UNAVAILABLE', 'WORKSPACE_LEASE_CONFLICT'].includes(code) ? 409 : 400);
  writeJson(res, status, {
    error: error?.message || fallback,
    ...(code ? { code } : {}),
  });
}

export async function handleCollaborationRoutes({
  req,
  res,
  pathname,
  authSession,
  readBody,
  requireSessionAccess,
  writeJson,
  orchestrator,
}) {
  if (!pathname.startsWith('/api/collaborations')) return false;
  const capabilityPrincipal = authSession?.principalKind === 'run_capability';
  const capabilityRootSessionId = text(authSession?.rootSessionId || authSession?.sessionId);
  if (!capabilityPrincipal && authSession?.role !== 'owner') {
    writeJson(res, 403, { error: 'Owner access required' });
    return true;
  }

  const parts = pathParts(pathname);
  const capabilityAllows = (operation) => !capabilityPrincipal || authSession.capabilityOperation === operation;
  if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'collaborations' && req.method === 'GET') {
    if (!capabilityAllows('collaboration.read')) {
      writeJson(res, 403, { error: 'Run capability is not authorized for collaboration reads' });
      return true;
    }
    try {
      const records = await orchestrator.list({ activeOnly: false });
      const visible = capabilityPrincipal
        ? records.filter((record) => (
          (authSession.resourceType === 'collaboration'
            ? text(record?.id) === text(authSession.resourceId)
            : text(record?.rootSessionId) === capabilityRootSessionId)
        ))
        : records;
      writeJson(res, 200, { collaborations: visible });
    } catch (error) {
      writeError(res, writeJson, error, 'Failed to list collaborations');
    }
    return true;
  }

  if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'collaborations' && req.method === 'POST') {
    if (!capabilityAllows('collaboration.create')) {
      writeJson(res, 403, { error: 'Run capability is not authorized to create collaborations' });
      return true;
    }
    let payload = {};
    try {
      const body = await readBody(req, 128 * 1024);
      payload = body ? JSON.parse(body) : {};
    } catch (error) {
      writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid request body' });
      return true;
    }
    const rootSessionId = text(payload.rootSessionId || payload.sessionId);
    if (!rootSessionId) {
      writeJson(res, 400, { error: 'rootSessionId is required' });
      return true;
    }
    if (capabilityPrincipal && rootSessionId !== capabilityRootSessionId) {
      writeJson(res, 403, { error: 'Run capability is bound to another root session' });
      return true;
    }
    if (capabilityPrincipal && authSession.resourceType !== 'session') {
      writeJson(res, 403, { error: 'A collaboration-scoped capability cannot create a collaboration' });
      return true;
    }
    if (!await requireSessionAccess(res, authSession, rootSessionId)) return true;
    try {
      const collaboration = await orchestrator.dispatch({
        rootSessionId,
        title: text(payload.title),
        plan: payload.plan,
        projectId: text(payload.projectId),
        idempotencyKey: text(payload.idempotencyKey),
      });
      writeJson(res, 201, { collaboration });
    } catch (error) {
      writeError(res, writeJson, error, 'Failed to create collaboration');
    }
    return true;
  }

  // Validate is deliberately separate from create/dispatch. A model or UI can
  // show the normalized execution contract (dependencies, capability gates,
  // project binding and runtime selection) before any child Session or Run is
  // created. It uses the same authorization and compiler as POST /api/collaborations.
  if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'collaborations'
      && parts[2] === 'validate' && req.method === 'POST') {
    if (!capabilityAllows('collaboration.create')) {
      writeJson(res, 403, { error: 'Run capability is not authorized to validate collaborations' });
      return true;
    }
    let payload = {};
    try {
      const body = await readBody(req, 128 * 1024);
      payload = body ? JSON.parse(body) : {};
    } catch (error) {
      writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid request body' });
      return true;
    }
    const rootSessionId = text(payload.rootSessionId || payload.sessionId);
    if (!rootSessionId) {
      writeJson(res, 400, { error: 'rootSessionId is required' });
      return true;
    }
    if (capabilityPrincipal && (rootSessionId !== capabilityRootSessionId || authSession.resourceType !== 'session')) {
      writeJson(res, 403, { error: 'Run capability is bound to another root session' });
      return true;
    }
    if (!await requireSessionAccess(res, authSession, rootSessionId)) return true;
    try {
      const validation = await validateCollaborationPlanTool({
        rootSessionId,
        title: text(payload.title),
        plan: payload.plan,
        projectId: text(payload.projectId),
      }, { orchestrator });
      writeJson(res, 200, { validation });
    } catch (error) {
      writeError(res, writeJson, error, 'Collaboration plan is invalid');
    }
    return true;
  }

  if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'collaborations'
      && parts[2] === 'dispatch-validated' && req.method === 'POST') {
    if (!capabilityAllows('collaboration.create')) {
      writeJson(res, 403, { error: 'Run capability is not authorized to dispatch collaborations' });
      return true;
    }
    let payload = {};
    try {
      const body = await readBody(req, 8192);
      payload = body ? JSON.parse(body) : {};
    } catch (error) {
      writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid request body' });
      return true;
    }
    try {
      const validation = await getValidatedCollaborationPlan(text(payload.validationId));
      if (!validation || validation.expired) {
        const error = new Error('The validated collaboration plan is missing or expired; validate it again');
        error.code = 'COLLABORATION_VALIDATION_EXPIRED';
        error.statusCode = 409;
        throw error;
      }
      if (capabilityPrincipal && (authSession.resourceType !== 'session' || validation.rootSessionId !== capabilityRootSessionId)) {
        writeJson(res, 403, { error: 'Run capability is bound to another root session' });
        return true;
      }
      if (!await requireSessionAccess(res, authSession, validation.rootSessionId)) return true;
      const result = await dispatchValidatedCollaborationPlan({
        validationId: validation.validationId,
        idempotencyKey: text(payload.idempotencyKey),
      }, { orchestrator });
      writeJson(res, 201, result);
    } catch (error) {
      writeError(res, writeJson, error, 'Failed to dispatch validated collaboration');
    }
    return true;
  }

  if (![3, 4].includes(parts.length) || parts[0] !== 'api' || parts[1] !== 'collaborations') {
    writeJson(res, 404, { error: 'Collaboration route not found' });
    return true;
  }
  let collaborationId = parts[2];
  try { collaborationId = decodeURIComponent(collaborationId); } catch {}
  const collaboration = await orchestrator.get(collaborationId).catch(() => null);
  if (!collaboration) {
    writeJson(res, 404, { error: 'Collaboration not found' });
    return true;
  }
  if (capabilityPrincipal && authSession.resourceType === 'collaboration'
      && text(authSession.resourceId) !== text(collaboration.id)) {
    writeJson(res, 403, { error: 'Run capability is bound to another collaboration' });
    return true;
  }
  if (capabilityPrincipal && text(collaboration.rootSessionId) !== capabilityRootSessionId) {
    writeJson(res, 403, { error: 'Run capability is bound to another collaboration' });
    return true;
  }
  if (!await requireSessionAccess(res, authSession, collaboration.rootSessionId)) return true;

  try {
    if (req.method === 'GET') {
      if (!capabilityAllows('collaboration.read')) {
        writeJson(res, 403, { error: 'Run capability is not authorized for collaboration reads' });
        return true;
      }
      const execution = await getExecutionByScope('collaboration', collaboration.id, { includeDetails: true }).catch(() => null);
      writeJson(res, 200, { collaboration, ...(execution ? { execution } : {}) });
      return true;
    }
    if (parts.length === 4 && !['cancel', 'dispatch', 'retry'].includes(parts[3])) {
      writeJson(res, 404, { error: 'Collaboration action not found' });
      return true;
    }
    if (req.method === 'POST' && parts.length === 4 && parts[3] === 'dispatch') {
      if (!capabilityAllows('collaboration.dispatch')) {
        writeJson(res, 403, { error: 'Run capability is not authorized to dispatch collaborations' });
        return true;
      }
      writeJson(res, 200, { collaboration: await orchestrator.dispatch({ id: collaborationId }) });
      return true;
    }
    if (req.method === 'POST' && parts.length === 4 && parts[3] === 'cancel') {
      if (!capabilityAllows('collaboration.cancel')) {
        writeJson(res, 403, { error: 'Run capability is not authorized to cancel collaborations' });
        return true;
      }
      let payload = {};
      try {
        const body = await readBody(req, 8192);
        payload = body ? JSON.parse(body) : {};
      } catch {}
      await orchestrator.cancel(collaborationId, text(payload.reason) || 'cancelled by owner');
      writeJson(res, 200, { collaboration: await orchestrator.get(collaborationId) });
      return true;
    }
    if (req.method === 'POST' && parts.length === 4 && parts[3] === 'retry') {
      if (!capabilityAllows('collaboration.retry')) {
        writeJson(res, 403, { error: 'Run capability is not authorized to retry collaborations' });
        return true;
      }
      let payload = {};
      try {
        const body = await readBody(req, 8192);
        payload = body ? JSON.parse(body) : {};
      } catch {}
      const result = await orchestrator.retry(collaborationId, text(payload.reason) || 'manual retry requested');
      writeJson(res, 200, result || { retried: 0, collaboration: await orchestrator.get(collaborationId) });
      return true;
    }
  } catch (error) {
    writeError(res, writeJson, error);
    return true;
  }
  writeJson(res, 405, { error: 'Method not allowed' });
  return true;
}
