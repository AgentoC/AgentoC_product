// S24 owner-only organization API. Android/Web consume the projection; the
// explicit provisioning command is the only Runtime-owned mutation exposed.
import { createHash } from 'crypto';
import {
  ORG_AUTONOMOUS_PROVISIONING_ENABLED,
  ORG_PROJECTION_V1_ENABLED,
  ORG_PROJECTION_V2_ENABLED,
} from '../lib/config.mjs';
import { readBody as readRequestBody } from '../lib/utils.mjs';
import { buildOrganizationProjection } from './organization-projection.mjs';
import { createManagedSessionForNode } from './organization-managed-session-factory.mjs';
import { provisionRootLeadershipRevision } from './organization-provisioning.mjs';
import { getOrganization, getOrganizationByRootSession } from './organization-store.mjs';
import { cancelOrganizationDescendants } from './organization-hierarchy.mjs';

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function writeError(res, writeJson, error) {
  const code = text(error?.code);
  const status = code === 'ORGANIZATION_NOT_FOUND' ? 404 : error?.statusCode || 400;
  writeJson(res, status, { error: error?.message || 'Organization request failed', ...(code ? { code } : {}) });
}

export async function handleOrganizationRoutes({
  req,
  res,
  pathname,
  authSession,
  writeJson,
  readBody = readRequestBody,
  cancelDescendants = cancelOrganizationDescendants,
  provisionRevision = provisionRootLeadershipRevision,
  managedSessionFactory = createManagedSessionForNode,
  dispatchPhase = null,
}) {
  const organizationMatch = /^\/api\/organizations\/([^/]+)(?:\/(projection|cancel|provision))?$/.exec(String(pathname || ''));
  const phaseDispatchMatch = /^\/api\/organizations\/([^/]+)\/phases\/([^/]+)\/dispatch$/.exec(String(pathname || ''));
  const rootSessionMatch = /^\/api\/sessions\/([^/]+)\/organization\/projection$/.exec(String(pathname || ''));
  if (!organizationMatch && !phaseDispatchMatch && !rootSessionMatch) return false;
  if (phaseDispatchMatch) {
    if (authSession?.role !== 'owner') { writeJson(res, 403, { error: 'Owner access required' }); return true; }
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    let payload = {};
    try {
      const rawBody = await readBody(req, 32 * 1024);
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch (error) {
      writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid JSON body' });
      return true;
    }
    const organizationId = decodeURIComponent(phaseDispatchMatch[1]);
    const phaseId = decodeURIComponent(phaseDispatchMatch[2]);
    const revision = typeof payload.revision === 'string' && payload.revision.trim() ? Number(payload.revision) : payload.revision;
    const idempotencyKey = text(payload.idempotencyKey) || text(req.headers?.['idempotency-key']);
    try {
      const dispatcher = dispatchPhase || (await import('./organization-phase-dispatch.mjs')).dispatchOrganizationPhase;
      const result = await dispatcher({ organizationId, phaseId, revision, idempotencyKey });
      writeJson(res, 200, { dispatch: result });
    } catch (error) { writeError(res, writeJson, error); }
    return true;
  }
  const action = organizationMatch ? (organizationMatch[2] || '') : 'projection';
  const projectionEnabled = ORG_PROJECTION_V1_ENABLED || ORG_PROJECTION_V2_ENABLED;
  if (action === 'provision' ? !ORG_AUTONOMOUS_PROVISIONING_ENABLED : !projectionEnabled) return false;
  if (authSession?.role !== 'owner') { writeJson(res, 403, { error: 'Owner access required' }); return true; }
  const requestedId = decodeURIComponent(organizationMatch ? organizationMatch[1] : rootSessionMatch[1]);
  try {
    const org = organizationMatch
      ? await getOrganization(requestedId)
      : await getOrganizationByRootSession(requestedId);
    if (!org) { writeJson(res, 404, { error: 'Organization not found', code: 'ORGANIZATION_NOT_FOUND' }); return true; }
    if (req.method === 'GET' && (action === '' || action === 'projection')) {
      const requestUrl = req.url ? new URL(req.url, `http://${req.headers?.host || 'localhost'}`) : null;
      const sinceEventId = requestUrl ? Number(requestUrl.searchParams.get('sinceEventId') || 0) : 0;
      const projection = await buildOrganizationProjection(org.id, {
        version: ORG_PROJECTION_V2_ENABLED ? 2 : 1,
        sinceEventId: Number.isInteger(sinceEventId) && sinceEventId >= 0 ? sinceEventId : 0,
      });
      const etag = `"${createHash('sha256').update(JSON.stringify(projection)).digest('hex')}"`;
      if (req.headers?.['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return true; }
      res.setHeader?.('ETag', etag);
      res.setHeader?.('X-Organization-Projection-Schema', String(projection.schemaVersion));
      writeJson(res, 200, { projection });
      return true;
    }
    if (req.method === 'POST' && action === 'cancel') {
      const rootNodeId = text(req.headers?.['x-organization-root-node-id']);
      if (!rootNodeId) { writeJson(res, 400, { error: 'root node id is required', code: 'ORG_PROJECTION_INVALID' }); return true; }
      const result = await cancelDescendants({ organizationId: org.id, rootNodeId, reason: 'cancelled by owner' });
      writeJson(res, 200, { cancelled: result.cancelled?.length || 0 });
      return true;
    }
    if (req.method === 'POST' && action === 'provision') {
      let payload = {};
      try {
        const rawBody = await readBody(req, 32 * 1024);
        payload = rawBody ? JSON.parse(rawBody) : {};
      } catch (error) {
        writeJson(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid JSON body' });
        return true;
      }
      const revision = typeof payload.revision === 'string' && payload.revision.trim()
        ? Number(payload.revision)
        : payload.revision;
      if (!Number.isInteger(revision) || revision < 1) {
        writeJson(res, 400, { error: 'revision must be a positive integer', code: 'ORG_PROVISIONING_REVISION_INVALID' });
        return true;
      }
      const idempotencyKey = text(payload.idempotencyKey) || text(req.headers?.['idempotency-key']);
      if (!idempotencyKey) {
        writeJson(res, 400, { error: 'idempotencyKey is required', code: 'ORG_PROVISIONING_IDEMPOTENCY_REQUIRED' });
        return true;
      }
      const result = await provisionRevision({
        organizationId: org.id,
        revision,
        idempotencyKey,
        createManagedSession: managedSessionFactory,
      });
      writeJson(res, result?.attempted === false ? 503 : 200, { provisioning: result });
      return true;
    }
    writeJson(res, 405, { error: 'Method not allowed' });
  } catch (error) { writeError(res, writeJson, error); }
  return true;
}
