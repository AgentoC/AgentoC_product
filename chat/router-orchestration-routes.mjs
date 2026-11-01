// Owner-only read surface for the provider-neutral execution ledger. Domain
// APIs remain the write authority; this route is intentionally diagnostic and
// cannot claim Commands, resolve Interrupts, or restart work.
import { getExecution, listExecutions } from './orchestration-store.mjs';

function text(value, max = 240) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function queryValue(query, key) {
  const value = query?.[key];
  return Array.isArray(value) ? text(value[0]) : text(value);
}

function boundedLimit(value) {
  const parsed = Number(queryValue(value, 'limit'));
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : 100;
}

export async function handleOrchestrationRoutes({
  req,
  res,
  pathname,
  query,
  authSession,
  writeJson,
}) {
  if (!String(pathname || '').startsWith('/api/orchestrations')) return false;
  if (authSession?.role !== 'owner') {
    writeJson(res, 403, { error: 'Owner access required' });
    return true;
  }
  if (req.method !== 'GET') {
    writeJson(res, 405, { error: 'Method not allowed' });
    return true;
  }
  if (pathname === '/api/orchestrations') {
    const executions = await listExecutions({
      rootSessionId: queryValue(query, 'rootSessionId'),
      state: queryValue(query, 'state'),
      limit: boundedLimit(query),
    }).catch((error) => {
      writeJson(res, 500, { error: error?.message || 'Failed to list orchestrations' });
      return null;
    });
    if (!executions) return true;
    writeJson(res, 200, { executions });
    return true;
  }
  const match = /^\/api\/orchestrations\/([^/]+)$/.exec(pathname);
  if (!match) {
    writeJson(res, 404, { error: 'Orchestration route not found' });
    return true;
  }
  let executionId = match[1];
  try { executionId = decodeURIComponent(executionId); } catch {}
  const execution = await getExecution(executionId, { includeDetails: true }).catch((error) => {
    writeJson(res, 500, { error: error?.message || 'Failed to read orchestration' });
    return undefined;
  });
  if (execution === undefined) return true;
  if (!execution) {
    writeJson(res, 404, { error: 'Execution not found', code: 'ORCHESTRATION_NOT_FOUND' });
    return true;
  }
  writeJson(res, 200, { execution });
  return true;
}
