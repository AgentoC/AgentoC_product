import { readPreparationBody } from './message-preparation-routes.mjs';
import { readSessionApiScopeHeader, SESSION_API_SCOPE_HEADER } from './session-api-scope-contract.mjs';
import { sessionApiError } from './session-api-mutation-contract.mjs';
import { RUN_API_LIST_LIMIT, RUN_API_LIST_SCAN_LIMIT, RUN_API_EVENT_SCAN_LIMIT, RUN_API_EVENT_TEXT_BYTES,
  RUN_API_RESPONSE_BYTES, RUN_API_MAX_WAIT_MS, RUN_API_PATH, RUN_API_ITEM_PATH,
  runApiIdentifier, runApiInteger, projectApiRun } from './run-api-contract.mjs';
import { scopedRunRead, readApiRun, listApiRuns, readApiRunEvents, readApiRunResult, waitApiRun, cancelApiRun } from './run-api-store.mjs';

const ERRORS = new Set(['INVALID_ARGUMENT', 'PERMISSION_DENIED', 'METHOD_NOT_ALLOWED', 'RESOURCE_LIMIT',
  'RESOURCE_NOT_FOUND', 'REVISION_CONFLICT', 'CURSOR_STALE', 'REQUEST_EXPIRED', 'RUN_IDENTITY_CONFLICT',
  'SESSION_MUTATION_STORE_INVALID', 'SESSION_MUTATION_STORE_UNAVAILABLE', 'RUN_PUBLICATION_UNAVAILABLE',
  'MESSAGE_RUN_BINDING_INVALID']);
const queries = { list: ['limit', 'cursor'], events: ['afterSeq', 'historyRevision', 'limit'],
  wait: ['afterRevision', 'timeoutMs'], get: [], result: [], cancel: [], contract: [] };
export async function handleRunApiRoutes({ req, res, pathname, parsedUrl, authSession, requireSessionAccess, writeJson }) {
  const contract = pathname === '/api/run-api-contract';
  const match = pathname.match(/^\/api\/sessions\/([^/]+)\/app-api-runs(?:\/([^/]+)(?:\/(events|result|wait|cancel))?)?$/);
  if (!contract && !match) return false;
  res.setHeader?.('Cache-Control', 'private, no-store');
  const action = contract ? 'contract' : match[3] || (match[2] ? 'get' : 'list');
  try {
    if (authSession?.role !== 'owner' ||
        (authSession.principalKind && !['owner', 'trusted_device'].includes(authSession.principalKind)))
      throw sessionApiError('PERMISSION_DENIED', 403, 'Owner conditional Run access is required');
    const method = action === 'cancel' ? 'POST' : 'GET';
    if (req.method !== method) {
      res.setHeader?.('Allow', method);
      throw sessionApiError('METHOD_NOT_ALLOWED', 405, 'Unsupported Run API method');
    }
    // The production router uses node:url.parse(..., true), whose query object
    // collapses duplicate keys. Preserve its raw search for strict validation.
    const url = parsedUrl instanceof URL ? parsedUrl : new URL(pathname +
      (typeof parsedUrl?.search === 'string' ? parsedUrl.search : ''), 'http://localhost');
    if (url.search.length > 2048 || [...url.searchParams.keys()].some(key =>
      !queries[action].includes(key) || url.searchParams.getAll(key).length !== 1))
      throw sessionApiError('INVALID_ARGUMENT', 400, 'Unsupported or repeated Run query');
    if (contract) {
      writeJson(res, 200, { version: 1, scopeHeader: SESSION_API_SCOPE_HEADER,
        scopeContextPath: '/api/sessions/{sessionId}/app-api-context', readsDispatch: false,
        maxResponseBytes: RUN_API_RESPONSE_BYTES, listLimit: RUN_API_LIST_LIMIT, listSnapshotLimit: RUN_API_LIST_SCAN_LIMIT,
        eventScanLimit: RUN_API_EVENT_SCAN_LIMIT, eventTextBytes: RUN_API_EVENT_TEXT_BYTES,
        maxWaitMs: RUN_API_MAX_WAIT_MS, cancellationBodyBytes: 4096, cancellationDeadline: true,
        cancellationRequestedIsTerminal: false, cancellationReceipt: false, pauseSupported: false, resumeSupported: false,
        operations: [
          { id: 'runs.list', method: 'GET', path: RUN_API_PATH, readonly: true },
          { id: 'runs.get', method: 'GET', path: RUN_API_ITEM_PATH, readonly: true },
          ...['events', 'result', 'wait'].map(id => ({ id: `runs.${id}`, method: 'GET', path: `${RUN_API_ITEM_PATH}/${id}`, readonly: true })),
          { id: 'runs.cancel', method: 'POST', path: `${RUN_API_ITEM_PATH}/cancel`, readonly: false },
        ] });
      return true;
    }
    const sessionId = runApiIdentifier(decodeURIComponent(match[1]));
    const runId = match[2] == null ? null : runApiIdentifier(decodeURIComponent(match[2]));
    const scope = readSessionApiScopeHeader(req, sessionId);
    if (!scope) throw sessionApiError('INVALID_ARGUMENT', 400, 'The original Session scope header is required');
    const access = async () => {
      if (!await requireSessionAccess(res, authSession, sessionId, { metadataOnly: true }))
        throw sessionApiError('PERMISSION_DENIED', 403, 'Run Session access is unavailable');
    };
    // Preserve the canonical access gate's response on an initial denial.
    if (!await requireSessionAccess(res, authSession, sessionId, { metadataOnly: true })) return true;
    const q = url.searchParams;
    let result;
    if (action === 'list') result = await listApiRuns(sessionId, scope, {
      limit: runApiInteger(q.get('limit'), 1, RUN_API_LIST_LIMIT, RUN_API_LIST_LIMIT), cursor: q.get('cursor') });
    else if (action === 'get') result = await scopedRunRead(sessionId, scope, async () =>
      ({ version: 1, run: projectApiRun(await readApiRun(sessionId, runId)) }));
    else if (action === 'events') result = await readApiRunEvents(sessionId, runId, scope, {
      afterSeq: runApiInteger(q.get('afterSeq'), 0, Number.MAX_SAFE_INTEGER, 0),
      historyRevision: runApiInteger(q.get('historyRevision'), 0, Number.MAX_SAFE_INTEGER, null),
      limit: runApiInteger(q.get('limit'), 1, RUN_API_LIST_LIMIT, RUN_API_LIST_LIMIT) });
    else if (action === 'result') result = await readApiRunResult(sessionId, runId, scope);
    else if (action === 'wait') {
      const afterRevision = q.get('afterRevision');
      if (afterRevision != null && !/^[a-f0-9]{64}$/.test(afterRevision))
        throw sessionApiError('INVALID_ARGUMENT', 400, 'Invalid Run state revision');
      const controller = new AbortController();
      const close = () => controller.abort();
      res.once?.('close', close); req.once?.('aborted', close);
      try {
        result = await waitApiRun(sessionId, runId, scope, { afterRevision,
          timeoutMs: runApiInteger(q.get('timeoutMs'), 0, RUN_API_MAX_WAIT_MS, 15000),
          signal: controller.signal, authorize: access });
      } finally { res.off?.('close', close); req.off?.('aborted', close); }
    } else result = await cancelApiRun(sessionId, runId, scope, await readPreparationBody(req, 4096));
    // The known cancellation effect is durable before fresh delivery checks.
    await access();
    await scopedRunRead(sessionId, scope, async () => undefined);
    const body = { ...result, observedAt: new Date().toISOString() };
    if (Buffer.byteLength(JSON.stringify(body)) > RUN_API_RESPONSE_BYTES)
      throw sessionApiError('RESOURCE_LIMIT', 413, 'Run response exceeds its byte limit');
    writeJson(res, 200, body);
  } catch (error) {
    req.resume?.();
    if (res.destroyed || error?.name === 'AbortError' || res.writableEnded) return true;
    const encoding = error instanceof URIError;
    const history = typeof error?.code === 'string' && error.code.startsWith('SESSION_HISTORY_');
    const known = ERRORS.has(error?.code) && Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599;
    // No provider messages, paths, request keys or corrupt JSON excerpts leave the API.
    writeJson(res, encoding ? 400 : known ? error.statusCode : 503, {
      code: encoding ? 'INVALID_ARGUMENT' : history ? 'RUN_HISTORY_UNAVAILABLE' : known ? error.code : 'RUN_API_UNAVAILABLE',
      error: encoding ? 'Invalid Run identity encoding' : 'Run API operation is unavailable' });
  }
  return true;
}
