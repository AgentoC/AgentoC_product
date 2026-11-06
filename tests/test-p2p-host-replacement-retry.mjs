import assert from 'node:assert/strict';
import { p2pHostCount, startP2PHostForDevice, stopAllP2PHosts, stopP2PHost } from '../lib/p2p-host-registry.mjs';

const credentials = { iceServers: [{ urls: 'turn:example.test', username: 'test', credential: 'test' }],
  expiresAt: new Date(Date.now() + 120_000).toISOString() };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 6_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for replacement');
    await delay(20);
  }
}
function host(ready = Promise.resolve()) {
  let resolveDone;
  return { ready, done: new Promise(resolve => { resolveDone = resolve; }), stop: () => resolveDone() };
}
const base = { p2pAccess: { roomId: 'a'.repeat(40), secret: 'synthetic-secret' },
  signalingUrl: 'https://signal.example.test', iceServers: credentials.iceServers,
  expiresAt: new Date(Date.now() + 2_200).toISOString(), refreshHost: async () => credentials };
try {
  let starts = 0;
  const first = await startP2PHostForDevice('retry-device', { ...base,
    runHostAgent: async () => { if (++starts === 2) throw new Error('temporary startup failure'); return host(); } });
  assert.equal(first.started, true);
  await until(() => starts >= 3 && p2pHostCount() === 1);
  assert.equal(starts, 3, 'failed replacement should be retried');
  stopP2PHost('retry-device');

  let releaseReady;
  let revocationStarts = 0;
  const second = await startP2PHostForDevice('revoked-device', { ...base,
    expiresAt: new Date(Date.now() + 2_200).toISOString(),
    runHostAgent: async () => ++revocationStarts === 1 ? host() : host(new Promise(resolve => { releaseReady = resolve; })) });
  assert.equal(second.started, true);
  await until(() => releaseReady != null);
  stopP2PHost('revoked-device');
  releaseReady();
  await delay(1_200);
  assert.equal(p2pHostCount(), 0, 'revocation must prevent a late replacement from returning');
  assert.equal(revocationStarts, 2, 'revocation must cancel replacement retries');

  let cancelledStarts = 0;
  await startP2PHostForDevice('cancelled-device', { ...base,
    expiresAt: new Date(Date.now() + 2_200).toISOString(),
    runHostAgent: async () => { if (++cancelledStarts > 1) throw new Error('unavailable'); return host(); } });
  await until(() => cancelledStarts === 2 && p2pHostCount() === 0);
  stopP2PHost('cancelled-device');
  await delay(1_200);
  assert.equal(cancelledStarts, 2, 'revocation must cancel a queued retry');
  console.log('P2P host replacement retries transient startup failures and honors revocation');
} finally {
  await stopAllP2PHosts();
}
