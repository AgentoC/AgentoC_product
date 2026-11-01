import { parseSessionApiScope } from './session-api-scope-contract.mjs';
import { findSessionMeta } from './session-meta-store.mjs';
import { readMessageRun } from './message-commit-store.mjs';
import { projectApiRun, parseRunCancellation } from './run-api-contract.mjs';
import { readApiRunResult, scopedRunRead, cancelApiRun } from './run-api-store.mjs';
import { createMessageResultExport, readMessageResultExportChunk } from './message-result-exports.mjs';
import { temporaryPairingError } from '../lib/temporary-pairing-protocol.mjs';

const deny = () => { throw temporaryPairingError('temporary_resource_denied', 403); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key)) || Object.keys(value).length !== keys.length) deny();
}

/** Internal result reader. A transport must first authenticate the original device proof. */
export class TemporaryResultService {
  constructor({ host }) { this.host = host; }

  async checkpoint(principal, operation, scope, runId) {
    const evidence = await readMessageRun(runId);
    const run = evidence?.run;
    if (!run || run.sessionId !== scope.sessionId || evidence.binding.principalKind !== 'temporary_device') deny();
    const authority = await this.host.operationAuthority(principal);
    if (!same(authority, evidence.binding.temporaryAuthority)
      || !same(evidence.binding.scope, scope)) deny();
    await this.host.resourcePolicy.authorize(principal, operation,
      { session: await findSessionMeta(scope.sessionId), run });
    return evidence;
  }

  async run(principal, scopeInput, runId) {
    const scope = parseSessionApiScope(scopeInput, scopeInput?.sessionId);
    await this.checkpoint(principal, 'run.read', scope, runId);
    const result = await scopedRunRead(scope.sessionId, scope, async () => {
      const evidence = await this.checkpoint(principal, 'run.read', scope, runId);
      return projectApiRun(evidence.run);
    });
    await this.checkpoint(principal, 'run.read', scope, runId);
    return { version: 1, run: result };
  }

  async preview(principal, scopeInput, runId) {
    const scope = parseSessionApiScope(scopeInput, scopeInput?.sessionId);
    await this.checkpoint(principal, 'run.read', scope, runId);
    const result = await readApiRunResult(scope.sessionId, runId, scope);
    await this.checkpoint(principal, 'run.read', scope, runId);
    return result;
  }

  async manifest(principal, scopeInput, runId) {
    const scope = parseSessionApiScope(scopeInput, scopeInput?.sessionId);
    const evidence = await this.checkpoint(principal, 'result.export', scope, runId);
    const authorize = async () => { await this.checkpoint(principal, 'result.export', scope, runId); };
    const context = { instanceId: principal.instanceId, sessionId: scope.sessionId, requestId: evidence.run.requestId };
    const manifest = await createMessageResultExport(context, { authorize });
    await authorize();
    if (manifest.runId !== runId) deny();
    return { ...manifest, expiresAt: new Date(Math.min(Date.parse(manifest.expiresAt), principal.expiry)).toISOString() };
  }

  async chunk(principal, scopeInput, runId, resourceId, query) {
    exact(query, ['revision', 'offset', 'length']);
    const scope = parseSessionApiScope(scopeInput, scopeInput?.sessionId);
    const evidence = await this.checkpoint(principal, 'result.chunk', scope, runId);
    const authorize = async () => { await this.checkpoint(principal, 'result.chunk', scope, runId); };
    const context = { instanceId: principal.instanceId, sessionId: scope.sessionId, requestId: evidence.run.requestId };
    const result = await readMessageResultExportChunk(context, resourceId, query, { authorize });
    await authorize();
    if (result.runId !== runId) deny();
    return result;
  }

  async cancel(principal, scopeInput, runId, input) {
    const scope = parseSessionApiScope(scopeInput, scopeInput?.sessionId);
    const request = parseRunCancellation(input);
    if (Date.parse(request.expiresAt) > principal.expiry) deny();
    const evidence = await this.checkpoint(principal, 'run.cancel', scope, runId);
    const authority = evidence.binding.temporaryAuthority;
    const authorizeWrite = async latest => {
      if (!latest || latest.id !== runId || latest.sessionId !== scope.sessionId
        || !same(await this.host.operationAuthority(principal), authority)) deny();
      await this.host.resourcePolicy.authorize(principal, 'run.cancel',
        { session: await findSessionMeta(scope.sessionId), run: latest });
    };
    const result = await cancelApiRun(scope.sessionId, runId, scope, request,
      { authorize: authorizeWrite, authorizeWrite });
    await this.checkpoint(principal, 'run.cancel', scope, runId);
    return result;
  }
}
