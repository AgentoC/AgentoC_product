import { deliverAccountRendezvousResult } from './owner-auth-rendezvous-delivery.mjs';

// Only an explicit rate-limit rejection is replayed. Reuse the connection ID
// and expiration so an authorized reservation remains the same operation.
export function reserveRendezvousTurnConnection({ reserve, reservation, expiresAt, clock, signal,
  wait, monotonicMillis } = {}) {
  if (typeof reserve !== 'function' || !reservation?.connectionId) throw new TypeError('A fixed TURN reservation is required');
  return deliverAccountRendezvousResult({
    expiresAt, clock, signal, ...(wait ? { wait } : {}), ...(monotonicMillis ? { monotonicMillis } : {}),
    send: retrySignal => reserve({ ...reservation, signal: retrySignal }),
  });
}
