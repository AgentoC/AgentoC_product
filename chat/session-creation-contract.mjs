import { createHash } from 'node:crypto';

export function sessionCreationError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

// Canonicalize objects, but retain array order and distinguish omitted/null.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function parseSessionCreationRequest(payload, headerKey, principalScope) {
  const bodyKey = payload?.idempotencyKey;
  for (const value of [bodyKey, headerKey]) {
    if (value != null && (typeof value !== 'string' || !value.trim() || value.length > 200)) {
      throw sessionCreationError('INVALID_ARGUMENT', 'idempotencyKey must be a non-empty string of at most 200 characters');
    }
  }
  if (bodyKey != null && headerKey != null && bodyKey.trim() !== headerKey.trim()) {
    throw sessionCreationError('INVALID_ARGUMENT', 'Body and header idempotency keys differ');
  }
  const key = (bodyKey ?? headerKey)?.trim();
  if (!key) return null;
  if (payload.externalTriggerId) {
    throw sessionCreationError('INVALID_ARGUMENT', 'Use either a creation idempotency key or externalTriggerId thread reuse');
  }
  if (!principalScope) throw sessionCreationError('PERMISSION_DENIED', 'Authenticated creation identity is required', 403);
  const { idempotencyKey: ignoredKey, requestId: ignoredRequestId, ...content } = payload;
  return {
    key,
    principalScope,
    fingerprint: createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex'),
  };
}

export function findSessionCreationReplay(metas, request) {
  if (!request) return null;
  const existing = metas.find((meta) => meta.creationRequest?.key === request.key
    && meta.creationRequest?.principalScope === request.principalScope);
  if (existing && existing.creationRequest.fingerprint !== request.fingerprint) {
    throw sessionCreationError('SESSION_IDEMPOTENCY_CONFLICT', 'Session creation key was already used with different parameters', 409);
  }
  return existing || null;
}
