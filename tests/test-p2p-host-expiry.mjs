import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {startP2PHostForDevice,stopAllP2PHosts,p2pHostCount} from '../lib/p2p-host-registry.mjs';
const agents=[];
const options={p2pAccess:{roomId:'e'.repeat(40),secret:'synthetic-expiry-secret'},signalingUrl:'https://signal.example.test',
 iceServers:[{urls:'turn:turn.example.test',username:'fixture',credential:'fixture'}],
 runHostAgent:()=>{let done;const agent={ready:Promise.resolve(),done:new Promise(r=>done=r),stops:0,stop(){this.stops++;done();}};agents.push(agent);return agent;}};
await stopAllP2PHosts();
mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-25T00:00:00Z')});
try {
 let finishRefresh,refreshStarted=false;
 const first=await startP2PHostForDevice('expiry-device',{...options,expiresAt:new Date(Date.now()+2200).toISOString(),
  refreshHost:()=>{refreshStarted=true;return new Promise(r=>finishRefresh=r);}});
 assert(first.started);
 mock.timers.tick(1100);assert(refreshStarted);
 mock.timers.tick(1100);assert.equal(agents[0].stops,1);assert.equal(p2pHostCount(),0,'Expiry does not wait for the broker request');
 const replacement=await startP2PHostForDevice('expiry-device',{...options,expiresAt:new Date(Date.now()+5000).toISOString()});
 assert(replacement.started);assert.equal(p2pHostCount(),1);
 finishRefresh({iceServers:options.iceServers,expiresAt:new Date(Date.now()+9000).toISOString()});
 await Promise.resolve();await Promise.resolve();
 assert.equal(agents.length,2,'Late old refresh cannot replace a newly started host');assert.equal(agents[1].stops,0);
 mock.timers.tick(5000);assert.equal(agents[1].stops,1);assert.equal(p2pHostCount(),0,'No refresh provider still has a hard expiry');
 const expired=await startP2PHostForDevice('past-device',{...options,expiresAt:new Date(Date.now()-1).toISOString()});
 assert.equal(expired.reason,'turn-credentials-expired');assert.equal(agents.length,2);
 console.log('PASS P2P host hard expiry: pending refresh, stale completion, replacement, no provider and expired admission');
} finally {await stopAllP2PHosts();mock.timers.reset();}
