import { setTimeout as sleep } from 'node:timers/promises';

const MAX_DELIVERY_ATTEMPTS = 4;
const MAX_DELIVERY_WINDOW_MS = 120_000;
const DEFAULT_RATE_LIMIT_DELAY_MS = 5_000;

function expired() {
  return Object.assign(new Error('The original account rendezvous delivery window expired.'), {
    code: 'owner_auth_rendezvous_expired', statusCode: 410,
  });
}

/** Retry only an explicitly rejected final delivery, never its completed setup. */
export async function deliverAccountRendezvousResult({
  send,
  expiresAt,
  clock = Date.now,
  monotonicMillis = () => performance.now(),
  wait = (ms, signal) => sleep(ms, undefined, { signal }),
  signal,
}) {
  signal?.throwIfAborted();
  const deadline = Date.parse(expiresAt || '');
  const started = monotonicMillis();
  const budget = Math.min(MAX_DELIVERY_WINDOW_MS, deadline - clock());
  if (!Number.isFinite(budget) || budget <= 0) throw expired();
  const remaining = () => Math.min(deadline - clock(),
    budget - Math.max(0, monotonicMillis() - started));
  const deadlineSignal = AbortSignal.timeout(Math.ceil(budget));
  const deliverySignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
  for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    if (remaining() <= 0) throw expired();
    try {
      const result = await send(deliverySignal);
      signal?.throwIfAborted();
      if (remaining() <= 0) throw expired();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (remaining() <= 0) throw expired();
      if (error?.code !== 'owner_auth_broker_rate_limited' || error?.statusCode !== 429
        || attempt >= MAX_DELIVERY_ATTEMPTS) throw error;
      const hint = Number(error.retryAfterMs);
      const delay = Number.isFinite(hint) && hint > 0
        ? Math.max(1_000, hint) : DEFAULT_RATE_LIMIT_DELAY_MS;
      // Never shorten Retry-After to squeeze another request into this intent.
      if (delay >= remaining()) throw error;
      try {
        await wait(delay, deliverySignal);
      } catch (waitError) {
        signal?.throwIfAborted();
        if (remaining() <= 0) throw expired();
        throw waitError;
      }
    }
  }
}
