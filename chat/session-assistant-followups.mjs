import { findLatestAssistantMessage } from './history.mjs';
import { parseSessionLabelsFromAssistantContent } from './session-labels.mjs';
import { parseTaskCardFromAssistantContent } from './session-task-card.mjs';
import {
  buildMergedSuggestionSessionMeta,
  isMergedSuggestionEnabled,
  isSuggestionKindEnabled,
  triggerSessionMergedSuggestion,
} from './summarizer.mjs';

export async function findLatestAssistantMessageForRun(sessionId, runId) {
  // Scan backwards from the latest event and hydrate ONLY the matched message,
  // instead of loadHistory(includeBodies:true) which materializes the entire
  // transcript (OOM for very long sessions — the original restart-loop cause).
  return findLatestAssistantMessage(sessionId, {
    includeBodies: true,
    ...(runId ? { match: (event) => event?.runId === runId } : {}),
  });
}

export async function maybeApplyAssistantTaskCard(sessionId, runId, session = null, services = {}) {
  const currentSession = session || await services.getSession(sessionId);
  if (!currentSession || !services.isTaskCardEnabledForSession(currentSession)) {
    return null;
  }

  const assistantEvent = await findLatestAssistantMessageForRun(sessionId, runId);
  const taskCard = parseTaskCardFromAssistantContent(assistantEvent?.content || '');
  if (!taskCard) return null;

  return services.updateSessionTaskCard(sessionId, taskCard);
}

export async function maybeApplyAssistantSessionLabels(sessionId, runId, session = null, services = {}) {
  const currentSession = session || await services.getSession?.(sessionId);
  if (!currentSession || typeof services.applyAssistantSessionLabels !== 'function') {
    return null;
  }

  const assistantEvent = await findLatestAssistantMessageForRun(sessionId, runId);
  const labels = parseSessionLabelsFromAssistantContent(assistantEvent?.content || '');
  if (!labels) return null;

  return services.applyAssistantSessionLabels(sessionId, labels, { runId });
}

export function scheduleSessionTaskCardSuggestion(session, run, services = {}) {
  if (!session?.id || !run || services.isInternalSession(session)) {
    return false;
  }
  if (!services.isTaskCardEnabledForSession(session)) {
    return false;
  }

  // DS-05: when merged suggestions are enabled, this scheduler coalesces with
  // the workflow-state scheduler into one model call per completed turn; the
  // per-kind trigger stays as the legacy path.
  const suggestionDone = isMergedSuggestionEnabled()
    ? triggerSessionMergedSuggestion(buildMergedSuggestionSessionMeta(session, run))
    : services.triggerSessionTaskCardSuggestion({
        id: session.id,
        folder: session.folder,
        name: session.name || '',
        sourceName: session.sourceName || '',
        taskCard: session.taskCard,
        tool: run.tool || session.tool,
        model: run.model || undefined,
        effort: run.effort || undefined,
        thinking: false,
      });

  suggestionDone.then(async (result) => {
    if (!result?.taskCard || !isSuggestionKindEnabled('task-card')) return;
    // Freshness guard: only skip when a NEWER assistant message (from a
    // later run) exists. When history carries no assistant message at all
    // (one-shot runtimes do not persist assistant bodies), there is nothing
    // newer, so the suggestion computed from the latest turn is applied.
    const latestAssistant = await findLatestAssistantMessageForRun(session.id);
    if (latestAssistant && latestAssistant.runId !== run.id) return;
    await services.updateSessionTaskCard(session.id, result.taskCard);
  }).catch((error) => {
    console.error(`[task-card] Failed to update task card for ${session.id?.slice(0, 8)}: ${error.message}`);
  });

  return true;
}
