import { withSessionsMetaMutation } from './session-meta-store.mjs';
import { getRun, isTerminalRunState } from './runs.mjs';
import { sessionApiError } from './session-api-mutation-contract.mjs';

/** Bounded publication/activation only; no prompt, history, provider or network. */
export function publishSessionRun(sessionId, replaceRunId, publish, decorate = () => {}) {
  return withSessionsMetaMutation(async (rows, save) => {
    const snapshot = structuredClone(rows);
    const session = snapshot.find(row => row.id === sessionId);
    if (!session) throw sessionApiError('RESOURCE_NOT_FOUND', 404, 'Session is unavailable');
    if (session.pendingCompact)
      throw sessionApiError('SESSION_BUSY', 409, 'Session context compaction is pending');
    const activeId = session.activeRunId;
    if (activeId && activeId !== replaceRunId) {
      const active = await getRun(activeId);
      if (!active || !isTerminalRunState(active.state))
        throw sessionApiError('SESSION_BUSY', 409, 'Session acquired another active Run before publication');
    }
    const run = await publish();
    if (!run || run.sessionId !== sessionId) throw sessionApiError('MESSAGE_RUN_BINDING_INVALID', 503, 'Run admission identity is unavailable');
    session.activeRunId = run.id;
    delete session.lastAuthRecovery;
    decorate(session, run);
    session.updatedAt = new Date().toISOString();
    await save(snapshot, { immediate: true, durable: true });
    return { run, activeSession: structuredClone(session) };
  });
}
