import assert from 'node:assert/strict';
import { startP2PHostForDevice, requestP2PHostHandoff, getP2PHostHandoffPlan,
  commitP2PHostHandoff, stopP2PHost, stopAllP2PHosts } from '../lib/p2p-host-registry.mjs';

const flush = async () => { for (let n = 0; n < 80; n++) await Promise.resolve(); };
const agents = [], commits = [], releases = [];
function makeAgent(options) {
  let done; const result = { ready: Promise.resolve(), joined: Promise.resolve(), done: new Promise(r => { done = r; }),
    stopped: 0, suspended: 0, resumed: 0, notified: 0, activated: 0,
    stop() { if (!this.stopped++) done(); }, suspendSignaling() { this.suspended++; },
    resumeSignaling() { this.resumed++; }, requestCarrierHandoff() { this.notified++; return true; },
    activateHandoff() { this.activated++; } };
  agents.push({ agent: result, options }); return result;
}
const options = { p2pAccess: { roomId: 'fixture-room', secret: 'fixture-secret' }, signalingUrl: 'https://signal.fixture.invalid',
  iceServers: [{ urls: 'turn:fixture', username: 'u', credential: 'p' }], expiresAt: new Date(Date.now() + 120_000).toISOString(),
  activeConnectionId: 'old-lease', runHostAgent: async params => makeAgent(params),
  prepareHandoff: async () => ({ connectionId: 'new-lease', contract: { turn: { connectionId: 'new-lease' } },
    iceServers: [{ urls: 'turn:fixture', username: 'u', credential: 'p' }], expiresAt: new Date(Date.now() + 120_000).toISOString() }),
  commitHandoff: async (...args) => { commits.push(args); }, releaseHandoff: async (...args) => { releases.push(args); } };
try {
  assert.equal((await startP2PHostForDevice('a', options)).started, true);
  assert.equal(requestP2PHostHandoff('a', { from: 'wrong', signedExpiry: Date.now() + 30_000 }), false);
  assert.equal(requestP2PHostHandoff('a', { from: 'old-lease', signedExpiry: Date.now() + 30_000 }), true);
  assert.equal(requestP2PHostHandoff('a', { from: 'old-lease', signedExpiry: Date.now() + 30_000 }), false);
  await flush(); assert.equal(agents.length, 2);
  const [old, standby] = agents, id = standby.options.handoffId;
  assert.equal(standby.agent.notified, 1); assert.equal(old.agent.stopped, 0);
  assert.equal(getP2PHostHandoffPlan('other', id), null);
  assert.equal(getP2PHostHandoffPlan('a', 'wrong'), null);
  assert.equal(getP2PHostHandoffPlan('a', id).turn.connectionId, 'new-lease');
  assert.equal(await commitP2PHostHandoff('a', id), false, 'Standby must first authenticate');
  standby.options.onGatewayResponse({ path: '/api/auth/me', status: 200 });
  assert.equal(await commitP2PHostHandoff('a', id), true);
  assert.equal(await commitP2PHostHandoff('a', id), true);
  assert.equal(commits.length, 1);
  assert.equal(standby.agent.activated, 0, 'No promotion before the commit response is delivered on standby');
  standby.options.onGatewayResponse({ path: '/api/device-auth/turn/handoff/commit', status: 200 });
  await flush(); assert.equal(standby.agent.activated, 1); assert.equal(old.agent.stopped, 0);
  assert.equal(await commitP2PHostHandoff('a', id), true, 'A lost promotion response remains retryable');
  assert.deepEqual(releases, []);
  stopP2PHost('a'); await flush();

  let finish;
  const pending = { ...options, prepareHandoff: () => new Promise(resolve => { finish = resolve; }) };
  await startP2PHostForDevice('b', pending);
  assert(requestP2PHostHandoff('b', { from: 'old-lease', signedExpiry: Date.now() + 30_000 }));
  stopP2PHost('b');
  finish(await options.prepareHandoff()); await flush();
  assert.deepEqual(releases, [['b', 'new-lease']], 'A reservation arriving after revocation is released');
  let finishCommit;
  const racing = { ...options, commitHandoff: () => new Promise(resolve => { finishCommit = resolve; }) };
  await startP2PHostForDevice('c', racing);
  assert(requestP2PHostHandoff('c', { from: 'old-lease', signedExpiry: Date.now() + 30_000 }));
  await flush();
  const racingStandby = agents.at(-1), racingId = racingStandby.options.handoffId;
  racingStandby.options.onGatewayResponse({ path: '/api/auth/me', status: 200 });
  const lateCommit = commitP2PHostHandoff('c', racingId);
  stopP2PHost('c'); finishCommit();
  assert.equal(await lateCommit, false, 'A revoked device cannot promote after delayed commit');
  await flush();
  assert.equal(racingStandby.agent.activated, 0);
  assert.deepEqual(releases.at(-1), ['c', 'new-lease']);
  console.log('PASS signed handoff admission, standby probe, commit, promotion and late cleanup');
} finally { await stopAllP2PHosts(); }
