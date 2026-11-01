import { createHash } from 'node:crypto';
import { createRendezvousResultWaiters, rendezvousResultWaitMs,
  waitForRendezvousResultTick, RENDEZVOUS_RESULT_CHECKPOINT_MS } from './rendezvous-result-waiters.mjs';

const key = instanceId => createHash('sha256').update(instanceId).digest('hex');

/** Only a verified, currently bound instance can occupy a wait slot. */
export function createRendezvousInboxWait({
  waiters = createRendezvousResultWaiters({ maximumPerSubject: 2, maximumPerRequest: 2 }),
} = {}) {
  return {
    async poll({ instanceId, waitMs: rawWaitMs, signal, read }) {
      const waitMs = rendezvousResultWaitMs(rawWaitMs);
      const initial = await read();
      // Preserve the legacy one-shot QR claim path. Unknown keys cannot hold
      // connections open or negotiate immediate continuous empty polling.
      if (!waitMs || !initial.subjectId) return initial.value;
      const response = value => ({ ...value, inboxWaitVersion: 1 });
      if (initial.value.intent) return response(initial.value);
      const started = performance.now();
      const remaining = () => waitMs - (performance.now() - started);
      const waiter = waiters.subscribe({ requestId: key(instanceId),
        subjectId: key(instanceId), timeoutMs: waitMs, signal });
      try {
        const readFresh = async () => {
          const pending = waiter.pending;
          const current = await read(initial.subjectId);
          // A commit while a snapshot is in flight must be read again.
          return pending && !waiter.pending ? read(initial.subjectId) : current;
        };
        let current = await readFresh();
        while (!current.value.intent && remaining() > 0) {
          await waitForRendezvousResultTick(waiter, Math.min(RENDEZVOUS_RESULT_CHECKPOINT_MS, remaining()));
          signal?.throwIfAborted();
          // Other Accounts processes notify through fresh committed reads.
          // No store transaction or connection is held across the wait.
          current = await readFresh();
          if (!waiter.pending) break;
        }
        return response(current.value);
      } finally { waiter.cancel(); }
    },
    notify(instanceId) { waiters.notify(key(instanceId)); },
    close() { waiters.close(); },
  };
}
