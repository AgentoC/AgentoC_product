import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreP2PHostsForDevices, stopAllP2PHosts, stopP2PHost } from '../lib/p2p-host-registry.mjs';

const device = id => ({ id, status: 'bound', accountId: 'account-1', enrollmentKind: 'account-join' });

test('a stalled device does not block another device from recovering', async () => {
  let releaseFirst, secondReached;
  const firstPending = new Promise(resolve => { releaseFirst = resolve; });
  const secondStarted = new Promise(resolve => { secondReached = resolve; });
  const recovery = restoreP2PHostsForDevices([
    device('slow'), device('slow'), device('slow'), device('slow'), device('fast'),
  ], {
    getP2PAccess: async id => {
      if (id === 'slow') { await firstPending; throw new Error('fixture failure'); }
      return { roomId: 'a'.repeat(40), secret: 'synthetic' };
    },
    getBootstrap: async () => ({ turn: { iceServers: [{ urls: 'turn:example.test' }],
      expiresAt: new Date(Date.now() + 120_000).toISOString() } }),
    signalingUrl: 'https://signal.example.test',
    runHostAgent: () => {
      secondReached();
      return { ready: Promise.resolve(), done: new Promise(() => {}), stop() {} };
    },
  });
  let timer;
  try {
    await Promise.race([secondStarted, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('second device was blocked')), 500);
    })]);
  } finally {
    clearTimeout(timer);
    releaseFirst();
    const result = await recovery;
    assert.deepEqual(result.results.map(entry => entry.deviceId), ['slow', 'slow', 'slow', 'slow', 'fast']);
    assert.equal(result.failed, 4);
    assert.equal(result.results[4].started, true);
    stopP2PHost('fast');
  }
});

for (const mode of ['device', 'all']) {
  test(`${mode} stop fences a recovery waiting for bootstrap`, async () => {
    let release, entered;
    const pending = new Promise(resolve => { release = resolve; });
    const bootstrapping = new Promise(resolve => { entered = resolve; });
    let starts = 0;
    const recovery = restoreP2PHostsForDevices([device('revoked')], {
      signalingUrl: 'https://signal.example.test',
      getP2PAccess: async () => ({ roomId: 'b'.repeat(40), secret: 'synthetic' }),
      getBootstrap: async () => {
        entered(); await pending;
        return { turn: { iceServers: [{ urls: 'turn:example.test' }],
          expiresAt: new Date(Date.now() + 120_000).toISOString() } };
      },
      runHostAgent: () => { starts++; return { ready: Promise.resolve(), done: new Promise(() => {}), stop() {} }; },
    });
    await bootstrapping;
    if (mode === 'device') stopP2PHost('revoked'); else await stopAllP2PHosts();
    release();
    const result = await recovery;
    try {
      assert.equal(starts, 0, 'a stopped recovery must not resurrect a host');
      assert.equal(result.results[0].reason, mode === 'device' ? 'device-stopped' : 'registry-stopping');
    } finally { stopP2PHost('revoked'); }
  });
}

test('stopping a queued device does not cancel its neighbors or a later recovery', async () => {
  let release, reachedFour;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { reachedFour = resolve; });
  let count = 0, queuedCalls = 0;
  const recovery = restoreP2PHostsForDevices(['q1', 'q2', 'q3', 'q4', 'queued'].map(device), {
    getP2PAccess: async id => {
      if (id === 'queued') queuedCalls++;
      if (++count === 4) reachedFour();
      await pending;
      throw new Error('fixture failure');
    },
  });
  await started;
  stopP2PHost('queued');
  release();
  const result = await recovery;
  assert.equal(queuedCalls, 0);
  assert.equal(result.results[4].reason, 'device-stopped');
  assert.ok(result.results.slice(0, 4).every(entry => entry.reason === 'p2p-access-failed'));
  const fresh = await restoreP2PHostsForDevices([device('queued')], {
    getP2PAccess: async () => { queuedCalls++; throw new Error('new attempt'); },
  });
  assert.equal(queuedCalls, 1);
  assert.equal(fresh.results[0].reason, 'p2p-access-failed');
});

test('recovery bounds concurrent account requests and coalesces duplicate devices', async () => {
  let release, reachedFour;
  const pending = new Promise(resolve => { release = resolve; });
  const fourStarted = new Promise(resolve => { reachedFour = resolve; });
  let active = 0, peak = 0;
  const calls = new Map();
  const recovery = restoreP2PHostsForDevices(
    [device('a'), device('b'), device('c'), device('d'), device('a'), device('e')], {
      getP2PAccess: async id => {
        calls.set(id, (calls.get(id) || 0) + 1);
        active++; peak = Math.max(peak, active);
        if (active === 4) reachedFour();
        try { await pending; throw new Error('fixture failure'); }
        finally { active--; }
      },
    });
  let timer;
  try {
    await Promise.race([fourStarted, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('four independent devices did not start')), 500);
    })]);
    assert.equal(peak, 4);
    assert.equal(calls.has('e'), false);
  } finally {
    clearTimeout(timer);
    release();
    const result = await recovery;
    assert.equal(result.attempted, 6);
  }
  assert.equal(peak, 4);
  assert.equal(calls.get('a'), 1);
  assert.equal(calls.get('e'), 1);
});
