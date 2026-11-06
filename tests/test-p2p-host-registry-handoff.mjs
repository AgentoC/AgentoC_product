import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { p2pHostCount, startP2PHostForDevice, stopAllP2PHosts, stopP2PHost } from '../lib/p2p-host-registry.mjs';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function agent() {
  let finish;
  return { ready: Promise.resolve(), joined: Promise.resolve(), done: new Promise(resolve => { finish = resolve; }),
    stopped: 0, suspended: 0, resumed: 0, notified: 0,
    stop() { if (!this.stopped++) finish(); }, suspendSignaling() { this.suspended++; },
    resumeSignaling() { this.resumed++; }, requestCarrierHandoff() { this.notified++; return true; }, activateHandoff() {} };
}
await stopAllP2PHosts();
mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-11-06T00:00:00Z') });
try {
  const created = [];
  const runHostAgent = async options => { const host = agent(); created.push({ host, options }); return host; };
  const credentials = () => ({ iceServers: [{ urls: 'turn:relay.example.test', username: 'u', credential: 'p' }],
    expiresAt: new Date(Date.now() + 120_000).toISOString() });
  const base = { p2pAccess: { roomId: 'a'.repeat(40), secret: 'fixture' }, signalingUrl: 'https://signal.example.test',
    ...credentials(), expiresAt: new Date(Date.now() + 60_000).toISOString(), refreshHost: async () => credentials(), runHostAgent };
  assert.equal((await startP2PHostForDevice('handoff-device', base)).started, true);
  mock.timers.tick(30_000); await flush();
  assert.equal(created.length, 2);
  const old = created[0].host, standby = created[1].host;
  assert.equal(old.suspended, 1);
  assert.equal(standby.notified, 1);
  assert.equal(old.stopped, 0);
  created[1].options.onGatewayResponse({ path: '/api/auth/me', status: 401 }); await flush();
  assert.equal(old.stopped, 0, 'failed authentication must not promote a standby');
  created[1].options.onGatewayResponse({ path: '/api/auth/me', status: 200 }); await flush();
  assert.equal(p2pHostCount(), 1);
  assert.equal(old.stopped, 0, 'old host remains alive to drain existing requests');
  stopP2PHost('handoff-device');
  assert.equal(old.stopped, 1, 'revocation closes retiring host');
  assert.equal(standby.stopped, 1, 'revocation closes promoted host');

  created.length = 0;
  assert.equal((await startP2PHostForDevice('rollback-device', { ...base,
    expiresAt: new Date(Date.now() + 60_000).toISOString() })).started, true);
  mock.timers.tick(30_000); await flush();
  assert.equal(created.length, 2);
  mock.timers.tick(20_000); await flush();
  assert.equal(created[1].host.stopped, 1, 'unverified standby must be stopped');
  assert.equal(created[0].host.resumed, 1, 'old host signaling must be restored');
  stopP2PHost('rollback-device');

  let finishCreation;
  const pendingHost = agent();
  const lateHost = agent();
  let attempts = 0;
  const pending = await startP2PHostForDevice('revoke-device', { ...base,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    runHostAgent: () => ++attempts === 1 ? pendingHost : new Promise(resolve => { finishCreation = resolve; }) });
  assert.equal(pending.started, true);
  mock.timers.tick(30_000); await flush();
  assert.equal(pendingHost.suspended, 1);
  stopP2PHost('revoke-device');
  finishCreation(lateHost); await flush();
  assert.equal(pendingHost.stopped, 1);
  assert.equal(pendingHost.resumed, 0, 'revocation cannot resume old signaling');
  assert.equal(lateHost.stopped, 1, 'a late standby must not survive revocation');
  assert.equal(p2pHostCount(), 0);
  console.log('P2P registry promotes only verified standby, drains old host, and rolls back failures');
} finally { await stopAllP2PHosts(); mock.timers.reset(); }
