import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MANAGED_WORK_ROOT_DIR } from '../lib/config.mjs';
import { getPublicAvailableToolsAsync } from '../lib/tools.mjs';
import { createTemporaryRuntimeCatalog } from '../lib/temporary-runtime-catalog.mjs';
import { temporaryPairingError } from '../lib/temporary-pairing-protocol.mjs';
import { parseSessionCreationRequest } from './session-creation-contract.mjs';
import { createSessionWithOutcome, initializeCreatedSession } from './session-manager.mjs';
import { findSessionMeta, readSessionApiContext, withSessionApiScope } from './session-meta-store.mjs';
import { projectSessionApiContext } from './session-api-mutation-contract.mjs';
import { parseSessionApiScope } from './session-api-scope-contract.mjs';

export const TEMPORARY_SESSION_LIMIT = 16;
const fail = (suffix, status = 400) => { throw temporaryPairingError(`temporary_session_${suffix}`, status); };
function input(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['idempotencyKey', 'name', 'tool', 'interactionMode', 'uiLanguage'].includes(k))) fail('input_invalid');
  const p = { idempotencyKey: value.idempotencyKey, name: value.name ?? '', tool: value.tool,
    interactionMode: value.interactionMode ?? 'agent', uiLanguage: value.uiLanguage ?? 'auto' };
  if (typeof p.idempotencyKey !== 'string' || !p.idempotencyKey.trim() || p.idempotencyKey.length > 200
    || typeof p.name !== 'string' || p.name.length > 256 || /[\x00-\x1f\x7f]/.test(p.name)
    || typeof p.tool !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(p.tool)
    || !['agent', 'plan'].includes(p.interactionMode)
    || typeof p.uiLanguage !== 'string' || !/^(?:auto|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(p.uiLanguage)
    || p.uiLanguage.length > 32) fail('input_invalid');
  return Object.freeze(p);
}

/** Internal authenticated adapter. No HTTP exposure, provider execution, project selection or Owner role. */
export class TemporarySessionService {
  constructor({ host, workRoot = MANAGED_WORK_ROOT_DIR, availableTools = getPublicAvailableToolsAsync,
    runtimeCatalog = createTemporaryRuntimeCatalog }) {
    this.host = host; this.workRoot = resolve(workRoot); this.availableTools = availableTools;
    this.runtimeCatalog = runtimeCatalog;
  }

  async listRuntimes(principal) {
    await this.host.resourcePolicy.authorize(principal, 'runtime.list');
    let tools;
    try { tools = await this.availableTools(); } catch { tools = null; }
    if (!Array.isArray(tools)) fail('tools_unavailable', 503);
    const runtimes = await this.runtimeCatalog(tools);
    await this.host.revalidatePrincipal(principal);
    return { version: 1, runtimes };
  }

  async create(principal, payload) {
    const p = input(payload);
    const identity = await this.host.resourcePolicy.creationIdentity(principal);
    const request = parseSessionCreationRequest(p, null, identity.principalScope);
    // Provider discovery may spawn probes; never hold the global metadata actor while waiting for it.
    // A discovery outage cannot prevent reconciliation of an already accepted creation.
    let tools;
    try { tools = await this.availableTools(); } catch { tools = null; }
    const runtimes = Array.isArray(tools) ? await this.runtimeCatalog(tools).catch(() => null) : null;
    const folder = join(this.workRoot, 'temporary', principal.grantId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const outcome = await createSessionWithOutcome(folder, p.tool, p.name, {
      createdByPrincipalKind: identity.createdByPrincipalKind, createdByPrincipalId: identity.createdByPrincipalId,
      sourceId: 'temporary_pairing', sourceName: 'Temporary pairing',
      riskMode: 'safe', interactionMode: p.interactionMode, uiLanguage: p.uiLanguage,
      creationRequest: request, creationInitialization: { events: [] }, suppressBroadcast: true,
    }, { authorizeCommit: async ({ session, duplicate, sessions }) => {
      if (session.createdByPrincipalKind !== identity.createdByPrincipalKind
        || session.createdByPrincipalId !== identity.createdByPrincipalId
        || session.creationRequest?.principalScope !== identity.principalScope) fail('ownership_invalid', 403);
      if (!duplicate) {
        if (sessions.filter(s => s.createdByPrincipalKind === 'temporary_device'
          && s.createdByPrincipalId === principal.grantId).length >= TEMPORARY_SESSION_LIMIT) fail('capacity', 429);
        if (!Array.isArray(tools) || !Array.isArray(runtimes)) fail('tools_unavailable', 503);
        if (!runtimes.some(runtime => runtime.id === p.tool && runtime.ready === true)) fail('tool_unavailable', 409);
      }
      await this.host.resourcePolicy.authorize(principal, 'session.create');
    } });
    // This completes the already accepted creation journal; no template, welcome message or Run exists.
    await initializeCreatedSession(outcome.session.id);
    const context = await readSessionApiContext(outcome.session.id);
    if (!context) fail('not_found', 404);
    await this.host.resourcePolicy.authorize(principal, 'session.create');
    return { version: 1, duplicate: outcome.replayed === true, session: context, startsRun: false };
  }

  async read(principal, scopeInput) {
    const scope = parseSessionApiScope(scopeInput, scopeInput?.sessionId);
    const first = await findSessionMeta(scope.sessionId);
    await this.host.resourcePolicy.authorize(principal, 'session.read', { session: first });
    const result = await withSessionApiScope(scope.sessionId, scope, async () => {
      const meta = await findSessionMeta(scope.sessionId);
      await this.host.resourcePolicy.authorize(principal, 'session.read', { session: meta });
      return projectSessionApiContext(meta);
    });
    await this.host.revalidatePrincipal(principal);
    return { version: 1, session: result };
  }
}
