import { parseSessionApiScope } from './session-api-scope-contract.mjs';
import { parseMessagePreparation } from './message-preparation-contract.mjs';
import { prepareSessionApiMessage, readSessionApiMessagePreparation } from './message-preparation-store.mjs';
import { commitSessionApiMessage, readSessionApiMessageCommit, parseMessageCommit } from './message-commit-store.mjs';
import { findSessionMeta } from './session-meta-store.mjs';
import { scheduleScopedMessageRun } from './session-manager.mjs';
import { assertTemporaryMessageRequest } from '../lib/temporary-operation-authority.mjs';

/** Internal temporary adapter; public routing must still authenticate the device proof first. */
export class TemporaryMessageService {
  constructor({ host, schedule = scheduleScopedMessageRun }) { this.host = host; this.schedule = schedule; }

  async checkpoint(principal, operation, scope, meta) {
    return this.host.resourcePolicy.authorize(principal, operation,
      { session: meta || await findSessionMeta(scope.sessionId) });
  }

  async prepare(principal, scopeInput, payload) {
    const scope = parseSessionApiScope(scopeInput, scopeInput?.sessionId);
    const request = parseMessagePreparation(payload);
    await this.checkpoint(principal, 'message.prepare', scope);
    assertTemporaryMessageRequest(request, await this.host.operationAuthority(principal));
    const result = await prepareSessionApiMessage(scope.sessionId, scope, request,
      { authorize: meta => this.checkpoint(principal, 'message.prepare', scope, meta) });
    await this.host.revalidatePrincipal(principal);
    return result;
  }

  async preparation(principal, scopeInput, requestId) {
    const scope = parseSessionApiScope(scopeInput, scopeInput?.sessionId);
    await this.checkpoint(principal, 'message.receipt', scope);
    const result = await readSessionApiMessagePreparation(scope.sessionId, requestId, scope,
      { authorize: meta => this.checkpoint(principal, 'message.receipt', scope, meta) });
    await this.host.revalidatePrincipal(principal);
    return result;
  }

  async commit(principal, scopeInput, requestId, payload) {
    const scope = parseSessionApiScope(scopeInput, scopeInput?.sessionId);
    const input = parseMessageCommit(payload);
    await this.checkpoint(principal, 'message.commit', scope);
    const temporaryAuthority = await this.host.operationAuthority(principal);
    const result = await commitSessionApiMessage(scope.sessionId, scope, requestId, input, 'temporary_device',
      { temporaryAuthority, authorize: meta => this.checkpoint(principal, 'message.commit', scope, meta) });
    // The durable Run is already accepted. Scheduling failure must not turn it into an unaccepted reply.
    if (result.accepted && result.runId) {
      try { this.schedule(scope.sessionId, result.runId)?.catch?.(() => {}); } catch {}
    }
    await this.host.revalidatePrincipal(principal);
    return result;
  }

  async receipt(principal, scopeInput, requestId) {
    const scope = parseSessionApiScope(scopeInput, scopeInput?.sessionId);
    await this.checkpoint(principal, 'message.receipt', scope);
    const result = await readSessionApiMessageCommit(scope.sessionId, scope, requestId,
      { authorize: meta => this.checkpoint(principal, 'message.receipt', scope, meta) });
    await this.host.revalidatePrincipal(principal);
    return result;
  }
}
