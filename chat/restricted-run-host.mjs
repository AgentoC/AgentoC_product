// Internal candidate coordinator. No HTTP route, environment enable switch or
// default worker. Product temporary scheduling keeps its refusal boundary.
import { createHash, randomUUID } from 'node:crypto';
import { continueScopedMessageRun, readMessageRun } from './message-commit-store.mjs';
import { authorizeTemporaryMessage } from './temporary-message-authorization.mjs';
import { findSessionMeta, withSessionApiScope, mutateSessionMeta } from './session-meta-store.mjs';
import { withoutMessageExecution } from './message-execution-context.mjs';
import { getRunAcceptanceEvidence, updateRun, isTerminalRunState, writeRunResult, appendRunSpoolRecord } from './runs.mjs';
import { appendRetainedMessageEvent } from './history.mjs';
import { messageEvent } from './normalizer.mjs';
import { assertOrdinaryWindowsExecutionIdentity } from '../lib/windows-execution-identity.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const now = () => new Date().toISOString();

export function restrictedRunAuthorityHash(evidence) {
  return digest([evidence.run.id, evidence.run.runPublication,
    evidence.binding.bindingHash, evidence.record.fingerprint]);
}

export class RestrictedRunHost {
  #active = new Map();
  constructor({ host, worker, pollMs = 250, onFailure }) {
    if (!host || typeof host.authorizeStoredMessage !== 'function') fail('RESTRICTED_HOST_AUTHORITY_REQUIRED');
    this.host = host; this.worker = worker;
    this.onFailure = typeof onFailure === 'function' ? onFailure : null;
    this.pollMs = Number.isFinite(pollMs) ? Math.max(25, Math.min(1000, pollMs)) : 250;
  }

  async authorize(binding, session) {
    if (binding?.principalKind !== 'temporary_device') fail('RESTRICTED_HOST_PRINCIPAL_INVALID');
    await authorizeTemporaryMessage(binding, session, { host: this.host });
  }

  async evidence(runId, lease, { execution = false } = {}) {
    const value = await readMessageRun(runId);
    if (!value || value.binding.principalKind !== 'temporary_device') fail('RESTRICTED_HOST_PRINCIPAL_INVALID');
    const session = await findSessionMeta(value.run.sessionId);
    await this.authorize(value.binding, session);
    if (Date.parse(value.record.request.expiresAt) <= Date.now()) fail('REQUEST_EXPIRED');
    if (lease && (restrictedRunAuthorityHash(value) !== lease.authorityHash
      || value.run.restrictedExecution?.leaseId !== lease.leaseId)) fail('RESTRICTED_RUN_FENCE_INVALID');
    if (execution && (session.activeRunId !== runId || value.run.cancelRequested
      || isTerminalRunState(value.run.state))) fail(value.run.cancelRequested ? 'REQUEST_CANCELLED' : 'RESTRICTED_RUN_FENCE_INVALID');
    return value;
  }

  start(runId) {
    if (this.#active.has(runId)) return this.#active.get(runId);
    const running = this.#start(runId).finally(() => this.#active.delete(runId));
    this.#active.set(runId, running);
    return running;
  }

  async #start(runId) {
    if (!this.worker || typeof this.worker.execute !== 'function' || typeof this.worker.preflight !== 'function') {
      fail('RESTRICTED_EXECUTION_UNAVAILABLE');
    }
    const existing = await readMessageRun(runId);
    if (!existing) fail('RESTRICTED_HOST_PRINCIPAL_INVALID');
    await this.authorize(existing.binding, await findSessionMeta(existing.run.sessionId));
    if (isTerminalRunState(existing.run.state) || existing.run.runnerStartedAt)
      return { waiting: false, run: existing.run };
    await this.evidence(runId); // No worker/credential work before stored authority.
    if (existing.record.request.attachments.length) fail('RESTRICTED_ATTACHMENTS_UNAVAILABLE');
    if (this.worker.tool !== existing.binding.configuration.tool) fail('RESTRICTED_WORKER_TOOL_MISMATCH');
    await assertOrdinaryWindowsExecutionIdentity();
    await this.worker.preflight(); // Outside the global Session metadata actor.
    return continueScopedMessageRun(runId, {
      authorizeContinuation: (binding, session) => this.authorize(binding, session),
      assertExecutionBoundary: (run, manifest) => {
        if (manifest.appApiMessage?.principalKind !== 'temporary_device' || run.appApiMessageVersion !== 1)
          fail('RESTRICTED_HOST_PRINCIPAL_INVALID');
      },
      execute: evidence => this.#execute(evidence),
      settleFailure: (evidence, error) => this.#failBeforeDispatch(evidence, error),
    });
  }

  async scoped(lease, effect) {
    return withoutMessageExecution(() => withSessionApiScope(lease.sessionId, lease.scope, async () => {
      const evidence = await this.evidence(lease.runId, lease, { execution: true });
      if (Date.now() >= lease.expiresAtUnixMs) fail('REQUEST_EXPIRED');
      return effect(evidence);
    }));
  }

  async #execute(initial) {
    const runId = initial.run.id;
    const lease = Object.freeze({ version: 1, leaseId: randomUUID(), runId,
      sessionId: initial.run.sessionId, requestId: initial.run.requestId,
      grantId: initial.binding.temporaryAuthority.grantId, scope: Object.freeze(structuredClone(initial.binding.scope)),
      authorityHash: restrictedRunAuthorityHash(initial),
      expiresAtUnixMs: Math.min(Date.parse(initial.record.request.expiresAt),
        initial.binding.temporaryAuthority.expiresAt, Date.now() + 120000) });
    // Durable single-use claim. A cold host never retries a claimed model call.
    await updateRun(runId, current => {
      if (current.restrictedExecution || current.runnerStartedAt || isTerminalRunState(current.state))
        fail('RESTRICTED_RUN_ALREADY_CLAIMED');
      return { ...current, state: 'running', startedAt: now(), runnerStartedAt: now(),
        runnerLaunchMode: 'restricted-candidate-host', restrictedExecution: { ...lease, state: 'dispatched' } };
    }, { authorizeWrite: async () => {
      if (restrictedRunAuthorityHash(await this.evidence(runId)) !== lease.authorityHash) fail('RESTRICTED_RUN_FENCE_INVALID');
    } });

    const controller = new AbortController();
    let stopCode = '', polling = false;
    const stop = code => { stopCode ||= code; controller.abort(stopCode); };
    const timer = setInterval(async () => {
      if (polling || controller.signal.aborted) return;
      polling = true;
      try {
        await this.evidence(runId, lease, { execution: true });
        if (Date.now() >= lease.expiresAtUnixMs) fail('REQUEST_EXPIRED');
      } catch (error) { stop(error.code || 'RESTRICTED_AUTHORITY_UNAVAILABLE'); }
      finally { polling = false; }
    }, this.pollMs);
    const deadline = setTimeout(() => stop('REQUEST_EXPIRED'), Math.max(1, lease.expiresAtUnixMs - Date.now()));
    let workerStarted = false, stoppedConfirmed = false, acknowledgementTimer;
    try {
      await this.scoped(lease, async () => {});
      workerStarted = true;
      const outcome = await Promise.race([
        withoutMessageExecution(() => this.worker.execute({ lease,
          record: structuredClone(initial.record), binding: structuredClone(initial.binding), signal: controller.signal })),
        new Promise((_, reject) => { acknowledgementTimer = setTimeout(() => reject(Object.assign(
          new Error('Worker stop acknowledgement unavailable'), { code: 'RESTRICTED_WORKER_STOP_UNCONFIRMED' })),
        Math.max(1, lease.expiresAtUnixMs - Date.now()) + 15000); }),
      ]);
      if (!outcome || outcome.leaseId !== lease.leaseId || outcome.authorityHash !== lease.authorityHash
        || outcome.runId !== runId || outcome.requestId !== lease.requestId || outcome.grantId !== lease.grantId
        || outcome.stopped !== true) fail('RESTRICTED_WORKER_STOP_UNCONFIRMED');
      stoppedConfirmed = true;
      if (stopCode || !outcome.completed) {
        return this.#terminalFailure(lease, stopCode || 'RESTRICTED_WORKER_FAILED', true);
      }
      if (typeof outcome.text !== 'string' || !outcome.text.trim() || Buffer.byteLength(outcome.text) > 65536)
        fail('RESTRICTED_WORKER_RESULT_INVALID');
      const result = { completedAt: now(), exitCode: 0, signal: null,
        restrictedReceipt: { leaseId: lease.leaseId, authorityHash: lease.authorityHash, resultSha256: digest(outcome.text) } };
      // Model wait stays outside scope actors. Each bounded writer revalidates
      // the original grant, publication, scope, lease, cancellation and deadline.
      await this.scoped(lease, async evidence => {
        await appendRetainedMessageEvent(lease.sessionId, messageEvent('assistant', outcome.text, undefined,
          { id: `message-run:${runId}:restricted-result`, runId, requestId: lease.requestId, responseId: lease.requestId }));
        await this.evidence(runId, lease, { execution: true });
        await appendRunSpoolRecord(runId, { kind: 'restricted_result', receipt: result.restrictedReceipt });
        await updateRun(runId, current => ({ ...current, state: 'completed', completedAt: result.completedAt, result,
          restrictedExecution: { ...current.restrictedExecution, state: 'completed' } }),
        { authorizeWrite: async () => { await this.evidence(runId, lease, { execution: true }); } });
        // status.json durably contains the result/receipt before this mirror
        // becomes visible to legacy result-file observers. A rejected final
        // authorization must never leave an exit-0 result.json behind.
        await writeRunResult(runId, result);
      });
      await this.#releaseSession(lease);
      return await getRunAcceptanceEvidence(runId);
    } catch (error) {
      await this.#diagnose(runId, 'execution', error);
      // Missing cleanup acknowledgement cannot be presented as stopped or
      // retried by a cold coordinator. The active Session remains occupied.
      return this.#terminalFailure(lease, error.code || 'RESTRICTED_WORKER_FAILED', stoppedConfirmed || !workerStarted);
    } finally { clearInterval(timer); clearTimeout(deadline); clearTimeout(acknowledgementTimer); }
  }

  async #releaseSession(lease) {
    await withoutMessageExecution(() => mutateSessionMeta(lease.sessionId, session => {
      if (session.activeRunId !== lease.runId) return false;
      delete session.activeRunId; return true;
    }));
  }

  async #terminalFailure(lease, code, stopped) {
    const cancellation = code === 'REQUEST_CANCELLED';
    const run = await withoutMessageExecution(() => updateRun(lease.runId, current => {
      if (current.restrictedExecution?.leaseId !== lease.leaseId) fail('RESTRICTED_RUN_FENCE_INVALID');
      if (isTerminalRunState(current.state)) return current;
      return { ...current, state: stopped ? (cancellation ? 'cancelled' : 'failed') : 'running',
        ...(stopped ? { completedAt: now(), result: { completedAt: now(), exitCode: 1, cancelled: cancellation } } : {}),
        messageFailureCode: code, restrictedExecution: { ...current.restrictedExecution,
          state: stopped ? 'stopped' : 'stop-unconfirmed', failureCode: code } };
    }));
    if (stopped) await this.#releaseSession(lease);
    return run;
  }

  async #failBeforeDispatch(evidence, error) {
    await this.#diagnose(evidence.run.id, 'before-dispatch', error);
    await withoutMessageExecution(() => updateRun(evidence.run.id, current => {
      if (current.restrictedExecution || current.runnerStartedAt || isTerminalRunState(current.state)) return current;
      return { ...current, state: 'failed', completedAt: now(), messageFailureCode: error.code || 'PREPARATION_FAILED' };
    }));
    const latest = await getRunAcceptanceEvidence(evidence.run.id);
    if (!latest?.restrictedExecution) await this.#releaseSession({ sessionId: evidence.run.sessionId, runId: evidence.run.id });
  }

  async #diagnose(runId, phase, error) {
    // Private control-parent diagnostic hook, never serialized to a Run or HTTP.
    // Observer failure cannot replace the original execution/settlement result.
    if (!this.onFailure) return;
    const diagnostic = Object.freeze({ runId, phase, error: Object.freeze({
      code: error?.code, name: error?.name, syscall: error?.syscall,
      path: error?.path, dest: error?.dest,
    }) });
    let timer;
    try { await Promise.race([
      Promise.resolve().then(() => this.onFailure(diagnostic)).catch(() => {}),
      new Promise(done => { timer = setTimeout(done, 500); }),
    ]); } finally { clearTimeout(timer); }
  }
}
