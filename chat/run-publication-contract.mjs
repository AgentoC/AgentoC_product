import { randomUUID } from 'node:crypto';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function runPublicationError(code = 'RUN_PUBLICATION_UNAVAILABLE', statusCode = 503) {
  return Object.assign(new Error('Run execution publication is unavailable or inconsistent'), { code, statusCode });
}
function valid(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 2 && value.version === 1
    && typeof value.publicationId === 'string' && UUID.test(value.publicationId);
}
export function createRunPublication() {
  return { version: 1, publicationId: randomUUID() };
}
const identity = value => value === undefined ? null : value;
export function bindRunPublication(run, manifest = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || Object.hasOwn(manifest, 'runPublication')) throw runPublicationError('INVALID_ARGUMENT', 400);
  for (const key of ['id', 'sessionId', 'requestId']) {
    if (Object.hasOwn(manifest, key) && identity(manifest[key]) !== identity(run[key]))
      throw runPublicationError('INVALID_ARGUMENT', 400);
  }
  return { ...manifest, id: run.id, sessionId: identity(run.sessionId),
    requestId: identity(run.requestId), runPublication: { ...run.runPublication } };
}
/** Legacy records remain readable; new publication markers cannot be downgraded. */
export function assertRunPublication(run, manifest) {
  const hasStatus = Object.hasOwn(run || {}, 'runPublication');
  const hasManifest = Object.hasOwn(manifest || {}, 'runPublication');
  if (!hasStatus && !hasManifest) return false;
  if (!valid(run?.runPublication) || !valid(manifest?.runPublication)
      || run.runPublication.publicationId !== manifest.runPublication.publicationId
      || manifest.id !== run.id || identity(manifest.sessionId) !== identity(run.sessionId)
      || identity(manifest.requestId) !== identity(run.requestId)) throw runPublicationError();
  return true;
}
export function retainRunPublication(previous, proposed) {
  if (!Object.hasOwn(previous || {}, 'runPublication')) return proposed;
  if (!valid(previous.runPublication)) throw runPublicationError();
  if (Object.hasOwn(proposed || {}, 'runPublication') &&
      (!valid(proposed.runPublication) || proposed.runPublication.publicationId !== previous.runPublication.publicationId))
    throw runPublicationError('RUN_PUBLICATION_CONFLICT', 409);
  for (const key of ['id', 'sessionId', 'requestId']) {
    if (Object.hasOwn(proposed || {}, key) && identity(proposed[key]) !== identity(previous[key]))
      throw runPublicationError('RUN_PUBLICATION_CONFLICT', 409);
  }
  return { ...proposed, id: previous.id, sessionId: identity(previous.sessionId),
    requestId: identity(previous.requestId), runPublication: { ...previous.runPublication } };
}
