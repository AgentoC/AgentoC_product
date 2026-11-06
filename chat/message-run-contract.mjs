import { createHash } from 'node:crypto';
import { parseSessionApiScope } from './session-api-scope-contract.mjs';
import { sessionApiError, sessionApiIdentifier } from './session-api-mutation-contract.mjs';
import { parseTemporaryOperationAuthority } from '../lib/temporary-operation-authority.mjs';
import { parseOwnerDeviceDescriptor } from './windows-owner-device-authority.mjs';

export const MESSAGE_CONFIGURATION_KEYS = Object.freeze([
  'folder', 'tool', 'model', 'effort', 'serviceTier', 'thinking', 'providerProfile',
  'agyProviderProfileId', 'uiLanguage', 'interactionMode', 'permissionMode',
  'templateId', 'templateName', 'systemPrompt', 'privilegedMode', 'riskMode', 'riskModeExplicit',
  'templatePerMessageSystemPrompt',
  'delegatedFromSessionId',
  'canDelegate', 'privilegeRoutingEnabled', 'claudeModelContract',
  'codexThreadModel', 'codexThreadEffort', 'codexThreadServiceTier',
].sort());
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function messageRunId(record) { return 'run_appapi_' + hash([record.sessionId, record.preparationId]).slice(0, 32); }
export function createMessageRunBinding(record, meta, principalKind, { temporaryAuthority, ownerDevice } = {}) {
  const configuration = Object.fromEntries(MESSAGE_CONFIGURATION_KEYS.map(key => [key,
    Object.hasOwn(meta, key) ? structuredClone(meta[key]) ?? null : null]));
  const boundOwnerDevice = principalKind === 'trusted_device' && ownerDevice ? parseOwnerDeviceDescriptor(ownerDevice) : null;
  const base = { version: principalKind === 'temporary_device' ? 2 : boundOwnerDevice ? 3 : 1, preparationId: record.preparationId, requestId: record.requestId,
    fingerprint: record.fingerprint, scope: record.scope, configuration, principalKind,
    ...(principalKind === 'temporary_device' ? { temporaryAuthority: parseTemporaryOperationAuthority(temporaryAuthority) } : {}),
    ...(boundOwnerDevice ? { ownerDevice: boundOwnerDevice } : {}) };
  return parseMessageRunBinding({ ...base, bindingHash: hash(base) });
}
export function parseMessageRunBinding(value) {
  try {
    const temporary = value?.version === 2 && value?.principalKind === 'temporary_device';
    const boundOwnerDevice = value?.version === 3 && value?.principalKind === 'trusted_device';
    if (!value || typeof value !== 'object' || Array.isArray(value) || (!temporary && !boundOwnerDevice && value.version !== 1) ||
        Object.keys(value).length !== (temporary || boundOwnerDevice ? 9 : 8) || Object.keys(value).some(key =>
          !['version', 'preparationId', 'requestId', 'fingerprint', 'scope', 'configuration', 'principalKind', 'bindingHash', ...(temporary ? ['temporaryAuthority'] : []), ...(boundOwnerDevice ? ['ownerDevice'] : [])].includes(key)) ||
        typeof value.preparationId !== 'string' || !/^mprep_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.preparationId) ||
        !/^[a-f0-9]{64}$/.test(value.fingerprint) || (!temporary && !['owner', 'trusted_device'].includes(value.principalKind))) throw new Error();
    sessionApiIdentifier(value.requestId);
    const scope = parseSessionApiScope(value.scope, value.scope.sessionId);
    const raw = value.configuration;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        Object.keys(raw).length !== MESSAGE_CONFIGURATION_KEYS.length ||
        MESSAGE_CONFIGURATION_KEYS.some(key => !Object.hasOwn(raw, key)) ||
        Buffer.byteLength(JSON.stringify(raw), 'utf8') > 256 * 1024) throw new Error();
    const configuration = Object.fromEntries(MESSAGE_CONFIGURATION_KEYS.map(key => [key, structuredClone(raw[key])]));
    for (const [key, input] of Object.entries(configuration)) {
      if (input === null) continue;
      if (['thinking', 'privilegedMode', 'riskModeExplicit', 'canDelegate', 'privilegeRoutingEnabled'].includes(key)) {
        if (typeof input !== 'boolean') throw new Error();
      } else if (key === 'templatePerMessageSystemPrompt') {
        if (typeof input !== 'object' || Array.isArray(input) ||
            Object.values(input).some(text => typeof text !== 'string' || text.includes('\0'))) throw new Error();
      } else if (key === 'claudeModelContract') {
        if (typeof input !== 'object' || Array.isArray(input)) throw new Error();
      } else if (typeof input !== 'string' || input.includes('\0')) throw new Error();
    }
    if (temporary && (configuration.riskMode !== 'safe' || configuration.privilegedMode !== false
      || configuration.canDelegate !== false || configuration.privilegeRoutingEnabled !== false
      || configuration.permissionMode !== null || configuration.templateId !== null)) throw new Error();
    const base = { version: value.version, preparationId: value.preparationId, requestId: value.requestId,
      fingerprint: value.fingerprint, scope, configuration, principalKind: value.principalKind,
      ...(temporary ? { temporaryAuthority: parseTemporaryOperationAuthority(value.temporaryAuthority) } : {}),
      ...(boundOwnerDevice ? { ownerDevice: parseOwnerDeviceDescriptor(value.ownerDevice) } : {}) };
    if (hash(base) !== value.bindingHash) throw new Error();
    return { ...base, bindingHash: value.bindingHash };
  } catch { throw sessionApiError('MESSAGE_RUN_BINDING_INVALID', 503, 'Scoped message Run binding is unavailable'); }
}
export function assertMessageRunBinding(run, manifest) {
  const marked = Object.hasOwn(run || {}, 'appApiMessageVersion');
  const bound = Object.hasOwn(manifest || {}, 'appApiMessage');
  if (!marked && !bound) return null;
  const binding = parseMessageRunBinding(manifest?.appApiMessage);
  if (run?.appApiMessageVersion !== 1 || binding.scope.sessionId !== run.sessionId ||
      binding.requestId !== run.requestId || messageRunId({ sessionId: run.sessionId, preparationId: binding.preparationId }) !== run.id)
    throw sessionApiError('MESSAGE_RUN_BINDING_INVALID', 503, 'Scoped message Run identity is unavailable');
  return binding;
}
export function retainMessageRunBinding(previous, proposed) {
  if (!Object.hasOwn(previous || {}, 'appApiMessage')) return proposed;
  const binding = parseMessageRunBinding(previous.appApiMessage);
  if (Object.hasOwn(proposed || {}, 'appApiMessage') &&
      parseMessageRunBinding(proposed.appApiMessage).bindingHash !== binding.bindingHash)
    throw sessionApiError('MESSAGE_IDEMPOTENCY_CONFLICT', 409, 'Original message Run binding cannot change');
  return { ...proposed, appApiMessage: binding };
}
