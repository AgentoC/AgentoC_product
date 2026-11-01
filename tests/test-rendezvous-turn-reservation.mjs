import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveRendezvousTurnConnection } from '../lib/rendezvous-turn-reservation.mjs';

const now = Date.parse('2026-10-29T00:00:00Z');
const deadline = new Date(now + 30_000).toISOString();
const reservation = Object.freeze({ deviceId: 'phone', deviceKind: 'phone', connectionId: 'fixed-lease',
  expiresAt: new Date(now + 900_000).toISOString() });
const rateLimit = () => Object.assign(new Error('rate limited'), {
  code: 'owner_auth_broker_rate_limited', statusCode: 429, retryAfterMs: 2000,
});

test('retries an explicitly throttled reservation using the same lease and expiry', async () => {
  const calls = [], delays = [];
  const result = await reserveRendezvousTurnConnection({ reservation, expiresAt: deadline, clock: () => now,
    monotonicMillis: () => 0, wait: async ms => { delays.push(ms); },
    reserve: async input => {
      calls.push(input);
      if (calls.length === 1) throw rateLimit();
      return { authorization: { authorized: true } };
    },
  });
  assert.equal(result.authorization.authorized, true);
  assert.deepEqual(delays, [2000]);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.connectionId, reservation.connectionId);
    assert.equal(call.expiresAt, reservation.expiresAt);
    assert.equal(call.deviceId, reservation.deviceId);
    assert.ok(call.signal instanceof AbortSignal);
  }
});

for (const code of ['turn_connection_quota_exceeded', 'owner_auth_broker_unavailable']) {
  test(`does not retry ${code}`, async () => {
    let calls = 0;
    await assert.rejects(reserveRendezvousTurnConnection({ reservation, expiresAt: deadline, clock: () => now,
      reserve: async () => { calls++; throw Object.assign(new Error(code), { code, statusCode: code.includes('quota') ? 429 : 503 }); },
    }), { code });
    assert.equal(calls, 1);
  });
}

test('does not attempt a reservation after the rendezvous deadline', async () => {
  let calls = 0;
  await assert.rejects(reserveRendezvousTurnConnection({ reservation, expiresAt: deadline, clock: () => now + 30_000,
    reserve: async () => { calls++; },
  }), { code: 'owner_auth_rendezvous_expired' });
  assert.equal(calls, 0);
});

test('cancellation during cooldown prevents another reservation', async () => {
  const controller = new AbortController();
  const reason = new Error('caller stopped');
  let calls = 0;
  await assert.rejects(reserveRendezvousTurnConnection({ reservation, expiresAt: deadline, clock: () => now,
    signal: controller.signal,
    reserve: async () => { calls++; throw rateLimit(); },
    wait: async () => { controller.abort(reason); throw reason; },
  }), error => error === reason);
  assert.equal(calls, 1);
});
