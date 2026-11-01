import { parseSessionApiScope } from './session-api-scope-contract.mjs';
import { withSessionApiScope } from './session-meta-store.mjs';
import { sessionApiError } from './session-api-mutation-contract.mjs';

export function parseUploadScope(scope, sessionId) {
  return scope == null ? null : parseSessionApiScope(scope, sessionId);
}

export function storedUploadScope(record) {
  const request = record.uploadRequest;
  if (!request || (!Object.hasOwn(request, 'scopeVersion') && !Object.hasOwn(request, 'scopeCondition'))) return null;
  try {
    if (request.scopeVersion !== 1) throw new Error();
    return parseSessionApiScope(request.scopeCondition, record.sessionId);
  } catch {
    throw sessionApiError('FILE_ASSET_RECEIPT_UNAVAILABLE', 503, 'Upload resource scope is invalid');
  }
}

export function requireUploadScope(record, input) {
  const stored = storedUploadScope(record);
  const supplied = parseUploadScope(input, record.sessionId);
  if (stored && !supplied)
    throw sessionApiError('INVALID_ARGUMENT', 400, 'The original upload scope condition is required');
  if (JSON.stringify(stored) !== JSON.stringify(supplied))
    throw sessionApiError('FILE_ASSET_IDEMPOTENCY_CONFLICT', 409, 'Upload resource scope differs from its original condition');
  return stored;
}

/** Streams stay outside the guard. Call bounded publication with the asset lock held. */
export function withUploadScope(record, input, effect, authorize) {
  const scope = requireUploadScope(record, input);
  const admitted = async () => { await authorize?.(record); return effect(); };
  return scope ? withSessionApiScope(record.sessionId, scope, admitted) : admitted();
}
