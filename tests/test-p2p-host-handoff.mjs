import assert from 'node:assert/strict';
import { tryP2PHostHandoff } from '../lib/p2p-host-handoff.mjs';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function agent() {
  return { ready: Promise.resolve(), joined: Promise.resolve(), suspended: 0, resumed: 0, stopped: 0, requests: 0,
    suspendSignaling() { this.suspended++; }, resumeSignaling() { this.resumed++; },
    requestCarrierHandoff() { this.requests++; return true; }, stop() { this.stopped++; } };
}
{
  const old = agent(), standby = agent(), proof = deferred();
  let promoted = 0;
  const task = tryP2PHostHandoff({ old, createStandby: async () => standby, verified: proof.promise,
    isCurrent: () => true, promote: async () => { promoted++; return true; }, deadlineMs: 20_000 });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(old.suspended, 1);
  assert.equal(standby.requests, 1);
  assert.equal(promoted, 0, 'a joined standby is not an authenticated carrier');
  proof.resolve();
  assert.equal(await task, true);
  assert.equal(promoted, 1);
  assert.equal(old.stopped, 0);
  assert.equal(standby.stopped, 0);
}
{
  const old = agent(), standby = agent();
  assert.equal(await tryP2PHostHandoff({ old, createStandby: async () => standby,
    verified: Promise.reject(new Error('not verified')), isCurrent: () => true, promote: async () => true, deadlineMs: 20_000 }), false);
  assert.equal(standby.stopped, 1);
  assert.equal(old.resumed, 1, 'unverified standby must restore the old signaling');
}
{
  const old = agent(), standby = agent(), creation = deferred(), controller = new AbortController();
  const task = tryP2PHostHandoff({ old, createStandby: () => creation.promise,
    verified: Promise.resolve(), isCurrent: () => true, promote: async () => true,
    signal: controller.signal, deadlineMs: 20_000 });
  controller.abort();
  creation.resolve(standby);
  assert.equal(await task, false);
  assert.equal(standby.stopped, 1, 'a late-created standby must be stopped after revocation');
  assert.equal(old.resumed, 0, 'revocation must not restore old signaling');
}
console.log('P2P handoff requires authenticated proof and fences failed or revoked standbys');
