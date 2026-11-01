// Short-lived in-process waiters for durable and opt-in live session events. The waiter is
// deliberately separate from history storage so event producers can notify
// after persistence without creating a dependency on the HTTP router.

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_WAITERS_PER_SESSION = 64;
const MAX_TOTAL_WAITERS = 512;

const waitersBySession = new Map();
let totalWaiters = 0;

function normalizeSessionId(sessionId) {
  return typeof sessionId === 'string' ? sessionId.trim() : '';
}

function normalizeTimeoutMs(timeoutMs) {
  const value = Number(timeoutMs);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

function addWaiter(sessionId, waiter) {
  let waiters = waitersBySession.get(sessionId);
  if (!waiters) {
    waiters = new Set();
    waitersBySession.set(sessionId, waiters);
  }
  if (totalWaiters >= MAX_TOTAL_WAITERS || waiters.size >= MAX_WAITERS_PER_SESSION) {
    return false;
  }
  waiters.add(waiter);
  totalWaiters += 1;
  return true;
}

function removeWaiter(sessionId, waiter) {
  const waiters = waitersBySession.get(sessionId);
  if (!waiters?.delete(waiter)) return;
  totalWaiters = Math.max(0, totalWaiters - 1);
  if (waiters.size === 0) waitersBySession.delete(sessionId);
}

function createNotification() {
  let resolveNotification;
  const promise = new Promise((resolve) => {
    resolveNotification = resolve;
  });
  return { promise, resolve: resolveNotification };
}

function resultHasEvents(result) {
  return Array.isArray(result?.events) && result.events.length > 0
    || Array.isArray(result?.liveEvents) && result.liveEvents.length > 0
    || result?.liveResetRequired === true;
}

/**
 * Register before reading so an append between the initial read and waiter
 * registration cannot be lost. `readEvents` must return a page-like value
 * with an `events` array.
 */
export async function waitForSessionEvents(sessionId, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  readEvents,
  signal,
} = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) throw new TypeError('sessionId is required');
  if (typeof readEvents !== 'function') throw new TypeError('readEvents is required');
  if (signal?.aborted) return { result: null, notified: false, timedOut: false, aborted: true };

  const initialWaiter = createNotification();
  const waiter = { resolve: initialWaiter.resolve };
  const registered = addWaiter(normalizedSessionId, waiter);
  if (!registered) {
    return {
      result: await readEvents(),
      notified: false,
      timedOut: true,
      throttled: true,
      aborted: false,
    };
  }

  let timer = null;
  let removeAbortListener = () => {};
  try {
    const initial = await readEvents();
    if (resultHasEvents(initial)) {
      return { result: initial, notified: false, timedOut: false, aborted: false };
    }

    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), normalizeTimeoutMs(timeoutMs));
    });
    const abortPromise = new Promise((resolve) => {
      if (!signal) return;
      const onAbort = () => resolve({ kind: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    });
    const outcome = await Promise.race([
      initialWaiter.promise.then(() => ({ kind: 'notified' })),
      timeoutPromise,
      abortPromise,
    ]);
    if (outcome.kind === 'aborted') {
      return { result: null, notified: false, timedOut: false, aborted: true };
    }
    const result = await readEvents();
    return {
      result,
      notified: outcome.kind === 'notified',
      timedOut: outcome.kind === 'timeout',
      aborted: false,
    };
  } finally {
    if (timer) clearTimeout(timer);
    removeAbortListener();
    removeWaiter(normalizedSessionId, waiter);
  }
}

/** Notify all current waiters after an event has been durably persisted. */
export function notifySessionEvents(sessionId, latestSeq = 0) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) return 0;
  const waiters = waitersBySession.get(normalizedSessionId);
  if (!waiters || waiters.size === 0) return 0;
  for (const waiter of waiters) {
    waiter.resolve({ latestSeq });
  }
  return waiters.size;
}

export function __getSessionEventWaiterCountForTest(sessionId) {
  return waitersBySession.get(normalizeSessionId(sessionId))?.size || 0;
}

export function __getTotalSessionEventWaitersForTest() {
  return totalWaiters;
}
