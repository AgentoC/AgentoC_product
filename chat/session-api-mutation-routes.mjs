import {
  applySessionApiMutation, readSessionApiContext, readSessionApiMutationReceipt,
} from './session-meta-store.mjs';
import {
  SESSION_API_KINDS, SESSION_API_RECEIPT_LIMIT, sessionApiError, sessionApiIdentifier,
} from './session-api-mutation-contract.mjs';

export const SESSION_API_MUTATION_BODY_BYTES = 8192;

async function readMutationBody(req) {
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > SESSION_API_MUTATION_BODY_BYTES) {
    req.resume();
    throw sessionApiError('RESOURCE_LIMIT', 413, 'Mutation body is too large');
  }
  const chunks = [];
  let size = 0;
  try {
    // Keep the response channel alive on rejection. The default Readable
    // iterator destroys IncomingMessage when a body-limit exception exits it.
    for await (const raw of req.iterator({ destroyOnReturn: false })) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.length;
      if (size > SESSION_API_MUTATION_BODY_BYTES)
        throw sessionApiError('RESOURCE_LIMIT', 413, 'Mutation body is too large');
      chunks.push(chunk);
    }
  } catch (error) {
    req.resume();
    throw error;
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw sessionApiError('INVALID_ARGUMENT', 400, 'Invalid mutation JSON'); }
}

/** Authenticated PC metadata contract; never dispatches or reconciles a Run. */
export async function handleSessionApiMutationRoutes({
  req, res, pathname, parsedUrl, authSession, requireSessionAccess, writeJson, invalidate,
}) {
  const contract = pathname === '/api/session-mutation-contract';
  const context = pathname.match(/^\/api\/sessions\/([^/]+)\/app-api-context$/);
  const mutation = pathname.match(/^\/api\/sessions\/([^/]+)\/app-api-mutations(?:\/([^/]+))?$/);
  if (!contract && !context && !mutation) return false;
  res.setHeader?.('Cache-Control', 'private, no-store');
  try {
    if (authSession?.role !== 'owner' ||
        (authSession.principalKind && !['owner', 'trusted_device'].includes(authSession.principalKind)))
      throw sessionApiError('PERMISSION_DENIED', 403, 'Owner access is required');
    if (parsedUrl?.searchParams?.size || parsedUrl?.search || Object.keys(parsedUrl?.query || {}).length)
      throw sessionApiError('INVALID_ARGUMENT', 400, 'Mutation query parameters are unsupported');
    const method = mutation && !mutation[2] ? 'POST' : 'GET';
    if (req.method !== method) {
      res.setHeader?.('Allow', method);
      throw sessionApiError('METHOD_NOT_ALLOWED', 405, 'Unsupported mutation method');
    }
    if (contract) {
      writeJson(res, 200, { version: 1, kinds: SESSION_API_KINDS, maxBodyBytes: SESSION_API_MUTATION_BODY_BYTES,
        maxRequestIdLength: 200, maxSessionIdLength: 256, maxTitleLength: 256,
        retainedReceiptsPerSession: SESSION_API_RECEIPT_LIMIT, conditionalMetadataOnly: true,
        contextPath: '/api/sessions/{sessionId}/app-api-context',
        mutationPath: '/api/sessions/{sessionId}/app-api-mutations',
        receiptPath: '/api/sessions/{sessionId}/app-api-mutations/{requestId}' });
      return true;
    }
    const sessionId = sessionApiIdentifier(decodeURIComponent((context || mutation)[1]), 256);
    const requestId = mutation?.[2] == null ? null : sessionApiIdentifier(decodeURIComponent(mutation[2]));
    if (!await requireSessionAccess(res, authSession, sessionId, { metadataOnly: true })) return true;
    if (context) {
      const result = await readSessionApiContext(sessionId);
      if (!result) throw sessionApiError('RESOURCE_NOT_FOUND', 404, 'Session is unavailable');
      writeJson(res, 200, result);
    } else if (requestId !== null) {
      writeJson(res, 200, await readSessionApiMutationReceipt(sessionId, requestId));
    } else {
      if (String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json')
        throw sessionApiError('INVALID_ARGUMENT', 415, 'Mutation requires application/json');
      const receipt = await applySessionApiMutation(sessionId, await readMutationBody(req));
      // Hints are best effort after persistence; their failure cannot change a
      // committed fact into an HTTP failure or make replay apply the effect again.
      if (!receipt.duplicate) {
        try { invalidate?.(receipt); }
        catch { console.error('[session-api] committed mutation invalidation failed'); }
      }
      writeJson(res, 200, receipt);
    }
  } catch (error) {
    const known = ['INVALID_ARGUMENT', 'RESOURCE_NOT_FOUND', 'REVISION_CONFLICT', 'RESOURCE_LIMIT',
      'SESSION_MUTATION_STORE_INVALID', 'SESSION_MUTATION_STORE_UNAVAILABLE', 'PERMISSION_DENIED', 'METHOD_NOT_ALLOWED'];
    const invalidEncoding = error instanceof URIError;
    const publicError = known.includes(error?.code) && Number.isInteger(error.statusCode);
    writeJson(res, invalidEncoding ? 400 : publicError ? error.statusCode : 503, {
      code: invalidEncoding ? 'INVALID_ARGUMENT' : publicError ? error.code : 'SESSION_MUTATION_STORE_UNAVAILABLE',
      error: invalidEncoding ? 'Invalid mutation identity encoding' : publicError ? error.message : 'Session mutation is unavailable',
    });
  }
  return true;
}
