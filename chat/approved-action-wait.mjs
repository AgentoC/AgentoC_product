import { getRun } from './runs.mjs';
import { hasPendingApprovedAction } from './runner-idle-policy.mjs';

const DEFAULT_POLL_INTERVAL_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Keep a detached runner alive while its provider has handed control to the
 * durable approved-action owner flow. The provider process may have exited,
 * but the runner unit must remain active so the privileged executor can verify
 * the run-bound cgroup when the owner later approves a host action.
 *
 * Cancellation and a missing run both release the wait. The session manager is
 * responsible for closing any still-pending action records when the runner
 * finally exits.
 */
export async function waitForApprovedActionResolution(runId, {
  getRunImpl = getRun,
  sleepImpl = sleep,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  const normalizedRunId = typeof runId === 'string' ? runId.trim() : '';
  if (!normalizedRunId) return null;

  while (true) {
    let current;
    try {
      current = await getRunImpl(normalizedRunId);
    } catch {
      // A transient storage/server restart must not release the runner unit:
      // doing so would make a still-valid owner approval fail its cgroup
      // liveness check. Retry until the run is observable again.
      await sleepImpl(Math.max(25, Number(pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS));
      continue;
    }
    if (!current || current.cancelRequested === true || !hasPendingApprovedAction(current)) {
      return current;
    }
    await sleepImpl(Math.max(25, Number(pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS));
  }
}
