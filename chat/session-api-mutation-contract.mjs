import { createHash, randomUUID } from 'node:crypto';

export const SESSION_API_MUTATION_VERSION = 1;
export const SESSION_API_RECEIPT_LIMIT = 64;
export const SESSION_API_KINDS = Object.freeze(['rename', 'setPinned', 'setArchived', 'setReviewed']);
export const SESSION_API_PRIVATE_FIELDS = Object.freeze(['appApiRevision', 'appApiScopeRevision', 'appApiMutationReceipts', 'appApiMessagePreparations']);
const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function token(value) { return typeof value === 'string' && TOKEN.test(value); }
function timestamp(value) {
  return typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value));
}

export function sessionApiError(code, statusCode, message) {
  return Object.assign(new Error(message), { code, statusCode });
}
export function sessionApiIdentifier(value, maximum = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value))
    throw sessionApiError('INVALID_ARGUMENT', 400, 'Invalid mutation identity');
  return value;
}
export function sessionApiProject(meta) {
  const value = meta?.projectId;
  // Legacy PC records use an empty project string for an unbound Session.
  if (value == null || value === '') return null;
  return sessionApiIdentifier(value, 256);
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)))
    throw sessionApiError('INVALID_ARGUMENT', 400, 'Unsupported mutation fields');
}
export function parseSessionApiMutation(value) {
  exactKeys(value, ['version', 'requestId', 'expectedRevision', 'expectedScopeRevision', 'expectedProjectId', 'kind', 'value']);
  if (value.version !== 1 || !SESSION_API_KINDS.includes(value.kind) ||
      !token(value.expectedRevision) || !token(value.expectedScopeRevision) ||
      !Object.hasOwn(value, 'expectedProjectId'))
    throw sessionApiError('INVALID_ARGUMENT', 400, 'Invalid mutation version or context');
  sessionApiIdentifier(value.requestId);
  const project = value.expectedProjectId;
  if (project !== null) sessionApiIdentifier(project, 256);
  if (value.kind === 'rename') {
    if (typeof value.value !== 'string' || !value.value.trim() || value.value.length > 256 || /[\x00-\x1f\x7f]/.test(value.value))
      throw sessionApiError('INVALID_ARGUMENT', 400, 'Invalid Session title');
  } else if (typeof value.value !== 'boolean') {
    throw sessionApiError('INVALID_ARGUMENT', 400, 'A boolean mutation value is required');
  }
  return Object.freeze({ version: 1, requestId: value.requestId, expectedRevision: value.expectedRevision,
    expectedScopeRevision: value.expectedScopeRevision, expectedProjectId: project, kind: value.kind, value: value.value });
}
export function sessionApiFingerprint(request) {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}
export function sessionApiScopeFingerprint(meta) {
  return JSON.stringify([sessionApiProject(meta), meta.folder ?? null, meta.sessionClass ?? null,
    meta.sessionPlane ?? null, meta.userAddressable ?? null, meta.visitorId ?? null, meta.internalRole ?? null]);
}
export function sessionApiMetadataFingerprint(meta) {
  return JSON.stringify([meta.name ?? null, meta.titleSource ?? null, meta.titleAnchorRunId ?? null, meta.autoRenamePending ?? null,
    meta.pinned === true, meta.archived === true, meta.lastReviewedAt ?? null]);
}

/** Separate value snapshots catch in-place bulk edits, including A -> B -> A saves. */
export function captureSessionApiRevisions(list) {
  return new Map(list.map(meta => [meta.id, { scope: sessionApiScopeFingerprint(meta),
    metadata: sessionApiMetadataFingerprint(meta), revision: meta.appApiRevision ?? null,
    scopeRevision: meta.appApiScopeRevision ?? null,
    messagePreparations: (Array.isArray(meta.appApiMessagePreparations) ? meta.appApiMessagePreparations : [])
      .map(row => JSON.stringify([row.preparationId, row.fingerprint, row.createdAt])) }]));
}
export function stampSessionApiRevisions(list, previous, { forceRevisionId = null } = {}) {
  let scopeChanged = false;
  for (const meta of list) {
    const before = previous.get(meta.id);
    const retainedPreparations = before?.messagePreparations || [];
    const currentPreparations = (Array.isArray(meta.appApiMessagePreparations) ? meta.appApiMessagePreparations : [])
      .map(row => JSON.stringify([row.preparationId, row.fingerprint, row.createdAt]));
    if (retainedPreparations.some(row => !currentPreparations.includes(row)))
      throw sessionApiError('MESSAGE_PREPARATION_STORE_INVALID', 503, 'Retained message preparations cannot be changed or dropped');
    const scope = sessionApiScopeFingerprint(meta);
    const metadata = sessionApiMetadataFingerprint(meta);
    for (const key of ['appApiRevision', 'appApiScopeRevision']) {
      if (meta[key] != null && !token(meta[key]))
        throw sessionApiError('SESSION_MUTATION_STORE_INVALID', 503, 'Invalid stored Session revision');
    }
    if (!before || !meta.appApiScopeRevision || before.scope !== scope) {
      meta.appApiScopeRevision = randomUUID(); scopeChanged = scopeChanged || (!!before && before.scope !== scope);
    } else meta.appApiScopeRevision = before.scopeRevision || meta.appApiScopeRevision;
    if (!before || !meta.appApiRevision || before.scope !== scope || before.metadata !== metadata || meta.id === forceRevisionId)
      meta.appApiRevision = randomUUID();
    else meta.appApiRevision = before.revision || meta.appApiRevision;
  }
  return { scopeChanged };
}

export function sessionApiReceipts(meta) {
  const value = meta.appApiMutationReceipts;
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > SESSION_API_RECEIPT_LIMIT)
    throw sessionApiError('SESSION_MUTATION_STORE_INVALID', 503, 'Invalid Session mutation journal');
  const ids = new Set();
  for (const row of value) {
    if (!object(row) || typeof row.requestId !== 'string' || !row.requestId.trim() || row.requestId.length > 200 ||
        /[\x00-\x1f\x7f]/.test(row.requestId) || ids.has(row.requestId) ||
        typeof row.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.fingerprint) || !token(row.scopeRevision) ||
        !object(row.receipt) || row.receipt.requestId !== row.requestId || !token(row.receipt.revision) ||
        row.receipt.scopeRevision !== row.scopeRevision || row.receipt.version !== 1 ||
        row.receipt.sessionId !== meta.id || !SESSION_API_KINDS.includes(row.receipt.kind) ||
        typeof row.receipt.changed !== 'boolean' || row.receipt.duplicate !== false || !timestamp(row.receipt.observedAt) ||
        Object.keys(row.receipt).some(key => !['version', 'requestId', 'sessionId', 'kind', 'changed',
          'revision', 'scopeRevision', 'observedAt', 'projectId', 'duplicate'].includes(key)) ||
        !Object.hasOwn(row.receipt, 'projectId') || (row.receipt.projectId !== null &&
          (typeof row.receipt.projectId !== 'string' || !row.receipt.projectId.trim() || row.receipt.projectId.length > 256 ||
           /[\x00-\x1f\x7f]/.test(row.receipt.projectId))))
      throw sessionApiError('SESSION_MUTATION_STORE_INVALID', 503, 'Invalid Session mutation journal');
    ids.add(row.requestId);
  }
  return value;
}

export function validateSessionApiStoredMeta(meta) {
  try {
    if (!object(meta)) throw new Error();
    sessionApiIdentifier(meta.id, 256);
    sessionApiProject(meta);
    for (const key of ['appApiRevision', 'appApiScopeRevision']) {
      if (meta[key] != null && !token(meta[key])) throw new Error();
    }
    sessionApiReceipts(meta);
  } catch {
    throw sessionApiError('SESSION_MUTATION_STORE_INVALID', 503, 'Invalid Session mutation storage');
  }
}

export function projectSessionApiContext(meta) {
  sessionApiIdentifier(meta.id, 256);
  if (!token(meta.appApiRevision) || !token(meta.appApiScopeRevision))
    throw sessionApiError('SESSION_MUTATION_STORE_INVALID', 503, 'Session context has no valid revision');
  const receipts = sessionApiReceipts(meta);
  const name = typeof meta.name === 'string' ? meta.name : '';
  let end = Math.min(name.length, 256);
  if (end < name.length && /[\uD800-\uDBFF]/.test(name[end - 1]) && /[\uDC00-\uDFFF]/.test(name[end])) end--;
  if (meta.lastReviewedAt != null && !timestamp(meta.lastReviewedAt))
    throw sessionApiError('SESSION_MUTATION_STORE_INVALID', 503, 'Invalid reviewed timestamp');
  return { version: 1, sessionId: meta.id, projectId: sessionApiProject(meta), revision: meta.appApiRevision,
    scopeRevision: meta.appApiScopeRevision, title: name.slice(0, end), titleTruncated: name.length > end,
    pinned: meta.pinned === true, archived: meta.archived === true,
    lastReviewedAt: typeof meta.lastReviewedAt === 'string' ? meta.lastReviewedAt : null,
    remainingMutationReceipts: SESSION_API_RECEIPT_LIMIT - receipts.length };
}

/** Apply only defined metadata effects. It never creates, cancels or resumes a Run. */
export function applySessionApiChange(meta, request, timestamp) {
  if (request.kind === 'rename') {
    const name = request.value.trim();
    const changed = meta.name !== name || meta.autoRenamePending !== false || meta.titleSource !== 'user' || !!meta.titleAnchorRunId;
    meta.name = name; meta.autoRenamePending = false; meta.titleSource = 'user';
    delete meta.titleAnchorRunId;
    if (changed) { meta.titleUpdatedAt = timestamp; meta.updatedAt = timestamp; }
    return changed;
  }
  if (request.kind === 'setReviewed') {
    const value = request.value ? timestamp : null;
    const changed = (meta.lastReviewedAt || null) !== value;
    if (value) meta.lastReviewedAt = value; else delete meta.lastReviewedAt;
    return changed;
  }
  const key = request.kind === 'setPinned' ? 'pinned' : 'archived';
  const changed = (meta[key] === true) !== request.value;
  if (request.value) meta[key] = true; else delete meta[key];
  return changed;
}
