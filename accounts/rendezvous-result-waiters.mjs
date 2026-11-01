export const MAX_RENDEZVOUS_RESULT_WAIT_MS = 10_000;
export const RENDEZVOUS_RESULT_CHECKPOINT_MS = 2_000;

export function rendezvousResultWaitMs(value) {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0 || value > MAX_RENDEZVOUS_RESULT_WAIT_MS) {
    throw Object.assign(new Error('Invalid bounded rendezvous wait.'), {
      code: 'owner_auth_rendezvous_wait_invalid', statusCode: 400,
    });
  }
  return value;
}

/** Notifications carry no authority or result. Callers must read again. */
export function createRendezvousResultWaiters({
  maximumWaiters = 128, maximumPerSubject = 16, maximumPerRequest = 2,
} = {}) {
  for (const [value, ceiling] of [[maximumWaiters, 128], [maximumPerSubject, 16], [maximumPerRequest, 2]]) {
    if (!Number.isInteger(value) || value < 1 || value > ceiling) throw new TypeError('Invalid waiter capacity');
  }
  const requests = new Map(), subjects = new Map();
  let total = 0, closed = false;
  return {
    subscribe({ requestId, subjectId, timeoutMs, signal }) {
      signal?.throwIfAborted();
      if (closed) throw Object.assign(new Error('Rendezvous wait service is closing.'), {
        code: 'owner_auth_rendezvous_wait_unavailable', statusCode: 503,
      });
      if (typeof requestId !== 'string' || !requestId || requestId.length > 128
        || typeof subjectId !== 'string' || !subjectId || subjectId.length > 512
        || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_RENDEZVOUS_RESULT_WAIT_MS) {
        throw new TypeError('Invalid waiter identity or deadline');
      }
      const set = requests.get(requestId) || new Set();
      if (total >= maximumWaiters || (subjects.get(subjectId) || 0) >= maximumPerSubject
        || set.size >= maximumPerRequest) {
        throw Object.assign(new Error('Rendezvous wait capacity reached.'), {
          code: 'owner_auth_rendezvous_wait_busy', statusCode: 429,
        });
      }
      let resolve, done = false, timer;
      const promise = new Promise(complete => { resolve = complete; });
      const abort = () => record.finish({ kind: 'aborted', reason: signal.reason });
      const record = { finish(value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        set.delete(record);
        if (!set.size) requests.delete(requestId);
        const count = subjects.get(subjectId) - 1;
        if (count) subjects.set(subjectId, count); else subjects.delete(subjectId);
        total--;
        resolve(value);
      } };
      set.add(record); requests.set(requestId, set);
      subjects.set(subjectId, (subjects.get(subjectId) || 0) + 1); total++;
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => record.finish({ kind: 'timeout' }), timeoutMs);
      if (signal?.aborted) abort();
      return { promise, get pending() { return !done; }, cancel: () => record.finish({ kind: 'cancelled' }) };
    },
    notify(requestId) {
      for (const record of [...(requests.get(requestId) || [])]) record.finish({ kind: 'notified' });
    },
    close() {
      closed = true;
      for (const set of [...requests.values()]) for (const record of [...set]) record.finish({ kind: 'closed' });
    },
    stats() { return { total, subjects: subjects.size, requests: requests.size }; },
  };
}

export async function waitForRendezvousResultTick(waiter, checkpointMs) {
  if (!waiter.pending) return waiter.promise;
  let timer;
  try {
    return await Promise.race([waiter.promise, new Promise(resolve => {
      timer = setTimeout(() => resolve({ kind: 'checkpoint' }), checkpointMs);
    })]);
  } finally { clearTimeout(timer); }
}
