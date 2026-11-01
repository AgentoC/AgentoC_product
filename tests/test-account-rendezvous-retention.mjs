import assert from 'node:assert/strict';
import {pruneExpiredRendezvousResults} from '../accounts/owner-auth-broker.mjs';
const now=Date.parse('2026-10-25T00:00:00Z');
const payload={credential:{token:'rda_synthetic_cache'},bootstrap:{turn:{iceServers:[{urls:'turn:fixture.test',username:'fixture',password:'fixture'}]}},p2p:{secret:'synthetic'}};
const make=(id,expiry,status='rendezvous_completed')=>({intentId:id,accountId:'acct_fixture',accountDeviceId:'adev_fixture',instanceId:'inst_fixture',deviceId:'rdev_fixture',devicePublicKey:'fixture',devicePublicKeyFingerprint:'fixture-fingerprint',completedAt:new Date(now-60000).toISOString(),expiresAt:expiry,status,rendezvousResult:structuredClone(payload)});
const intents=[make('past',new Date(now-1).toISOString()),make('boundary',new Date(now).toISOString()),make('live',new Date(now+1).toISOString()),make('invalid','not-a-date'),make('ordinary',new Date(now-1).toISOString(),'completed')];
const before=structuredClone(intents);
assert.equal(pruneExpiredRendezvousResults(intents,now),3);
for(const i of [0,1,4]){const {rendezvousResult:ignored,...identity}=before[i];assert.deepEqual(intents[i],{...identity,rendezvousResult:null});}
assert.deepEqual(intents[2],before[2]);assert.deepEqual(intents[3],before[3]);
assert.equal(pruneExpiredRendezvousResults(intents,now),0,'Repeated maintenance must not cause writes');
assert.equal(pruneExpiredRendezvousResults([],now),0);
assert.throws(()=>pruneExpiredRendezvousResults(intents,NaN),TypeError);
console.log('PASS rendezvous retention: exact expiry, live/invalid preservation, unchanged durable links and idempotence');
