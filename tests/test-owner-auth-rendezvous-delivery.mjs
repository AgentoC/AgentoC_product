import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliverAccountRendezvousResult } from '../lib/owner-auth-rendezvous-delivery.mjs';

const start = Date.parse('2026-10-26T00:00:00Z');
const rateLimited = (retryAfterMs) => Object.assign(new Error('rate limited'), {
  code: 'owner_auth_broker_rate_limited', statusCode: 429, retryAfterMs,
});

function fixture(windowMs = 120_000) {
  const state = { wall: start, mono: 0, calls: 0, delays: [] };
  const options = {
    expiresAt: new Date(start + windowMs).toISOString(),
    clock: () => state.wall,
    monotonicMillis: () => state.mono,
    wait: async (ms, signal) => {
      signal.throwIfAborted();
      state.delays.push(ms);
      state.wall += ms;
      state.mono += ms;
    },
  };
  return { state, options };
}

test('a rejected final publication resumes the same send after Retry-After', async () => {
  const { state, options } = fixture();
  const signals = [];
  const result = await deliverAccountRendezvousResult({ ...options, send: async signal => {
    signals.push(signal);
    if (++state.calls === 1) throw rateLimited(7_000);
    return { status: 'rendezvous_completed' };
  } });
  assert.deepEqual(result, { status: 'rendezvous_completed' });
  assert.equal(state.calls, 2);
  assert.deepEqual(state.delays, [7_000]);
  assert.equal(signals[0], signals[1], 'one original delivery deadline');
});

test('missing Retry-After defaults to five seconds and retries are bounded', async () => {
  const { state, options } = fixture();
  const error = rateLimited();
  await assert.rejects(deliverAccountRendezvousResult({ ...options, send: async () => {
    state.calls++;
    throw error;
  } }), e => e === error);
  assert.equal(state.calls, 4);
  assert.deepEqual(state.delays, [5_000, 5_000, 5_000]);
});

test('Retry-After is never shortened to fit an expiring intent', async () => {
  const { state, options } = fixture(7_000);
  const error = rateLimited(7_000);
  await assert.rejects(deliverAccountRendezvousResult({ ...options, send: async () => {
    state.calls++;
    throw error;
  } }), e => e === error);
  assert.equal(state.calls, 1);
  assert.deepEqual(state.delays, []);
});

test('a delayed wakeup cannot send again past the original deadline', async () => {
  const { state, options } = fixture(6_000);
  await assert.rejects(deliverAccountRendezvousResult({ ...options,
    wait: async () => { state.mono += 6_001; state.wall += 6_001; },
    send: async () => { state.calls++; throw rateLimited(1_000); },
  }), { code: 'owner_auth_rendezvous_expired' });
  assert.equal(state.calls, 1);
});

test('wall clock rollback cannot extend the monotonic delivery budget', async () => {
  const { state, options } = fixture(10_000);
  await assert.rejects(deliverAccountRendezvousResult({ ...options,
    wait: async () => { state.wall -= 60_000; state.mono += 10_001; },
    send: async () => { state.calls++; throw rateLimited(1_000); },
  }), { code: 'owner_auth_rendezvous_expired' });
  assert.equal(state.calls, 1);
});

test('a successful but late response is not accepted', async () => {
  const { state, options } = fixture(2_000);
  await assert.rejects(deliverAccountRendezvousResult({ ...options, send: async () => {
    state.calls++;
    state.mono += 2_001;
    return { status: 'rendezvous_completed' };
  } }), { code: 'owner_auth_rendezvous_expired' });
  assert.equal(state.calls, 1);
});

test('a deadline that passes during a rate limited response is not retried', async () => {
  const { state, options } = fixture(2_000);
  await assert.rejects(deliverAccountRendezvousResult({ ...options, send: async () => {
    state.calls++;
    state.wall += 2_001;
    throw rateLimited(1_000);
  } }), { code: 'owner_auth_rendezvous_expired' });
  assert.equal(state.calls, 1);
});

test('even an unusually long server intent retains the 120 second budget', async () => {
  const { state, options } = fixture(300_000);
  await assert.rejects(deliverAccountRendezvousResult({ ...options, send: async () => {
    state.calls++;
    state.mono += 120_001;
    return {};
  } }), { code: 'owner_auth_rendezvous_expired' });
  assert.equal(state.calls, 1);
});

for (const expiresAt of ['', 'invalid', new Date(start).toISOString()]) {
  test(`invalid or expired intent refuses publication (${expiresAt || 'empty'})`, async () => {
    const { state, options } = fixture();
    await assert.rejects(deliverAccountRendezvousResult({ ...options, expiresAt,
      send: async () => { state.calls++; },
    }), { code: 'owner_auth_rendezvous_expired' });
    assert.equal(state.calls, 0);
  });
}

for (const statusCode of [401, 403, 409, 410, 503]) {
  test(`a ${statusCode} rejection after 429 is passed through without another retry`, async () => {
    const { state, options } = fixture();
    const error = Object.assign(new Error('rejected'), { statusCode });
    await assert.rejects(deliverAccountRendezvousResult({ ...options, send: async () => {
      if (++state.calls === 1) throw rateLimited(1_000);
      throw error;
    } }), e => e === error);
    assert.equal(state.calls, 2);
  });
}

test('an unknown send error is not retried by the delivery loop', async () => {
  const { state, options } = fixture();
  const error = new TypeError('unknown transport outcome');
  await assert.rejects(deliverAccountRendezvousResult({ ...options, send: async () => {
    state.calls++;
    throw error;
  } }), e => e === error);
  assert.equal(state.calls, 1);
});

test('external cancellation during cooldown keeps its original reason', async () => {
  const { state, options } = fixture();
  const controller = new AbortController();
  const reason = new Error('caller stopped');
  await assert.rejects(deliverAccountRendezvousResult({ ...options, signal: controller.signal,
    wait: async (_ms, signal) => { controller.abort(reason); signal.throwIfAborted(); },
    send: async () => { state.calls++; throw rateLimited(1_000); },
  }), e => e === reason);
  assert.equal(state.calls, 1);
});

test('external cancellation before publication makes no request', async () => {
  const { state, options } = fixture();
  const controller = new AbortController();
  const reason = new Error('caller already stopped');
  controller.abort(reason);
  await assert.rejects(deliverAccountRendezvousResult({ ...options, signal: controller.signal,
    send: async () => { state.calls++; },
  }), e => e === reason);
  assert.equal(state.calls, 0);
});

test('the real cooldown timer preserves the external cancellation reason', async () => {
  const { state, options } = fixture();
  const controller = new AbortController();
  const reason = new Error('caller stopped real timer');
  const pending = deliverAccountRendezvousResult({ ...options, wait: undefined,
    signal: controller.signal, send: async () => {
      state.calls++;
      setTimeout(() => controller.abort(reason), 5);
      throw rateLimited(1_000);
    },
  });
  await assert.rejects(pending, e => e === reason);
  assert.equal(state.calls, 1);
});

test('external cancellation is not replaced by a send rejection', async () => {
  const { state, options } = fixture();
  const controller = new AbortController();
  const reason = new Error('caller stopped in flight');
  await assert.rejects(deliverAccountRendezvousResult({ ...options, signal: controller.signal,
    send: async signal => {
      state.calls++;
      controller.abort(reason);
      assert.equal(signal.aborted, true);
      throw rateLimited(1_000);
    },
  }), e => e === reason);
  assert.equal(state.calls, 1);
});
