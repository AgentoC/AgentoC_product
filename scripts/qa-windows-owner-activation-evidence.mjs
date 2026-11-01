// Independent comparison of protected SCM exports and ordinary Owner proofs.
import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {activationStages} from '../tests/fixtures/windows-service-owner-activation-probe.mjs';
export async function verifyOwnerActivation({manifest,summary,bundle,protectedRoot,sids,pids}){
 const before=JSON.parse(await readFile(join(bundle,'production-before.json'),'utf8')),after=JSON.parse(await readFile(join(bundle,'production-after.json'),'utf8'));assert.deepEqual(before,after);
 const client=JSON.parse(await readFile(join(bundle,'owner-activation-client.json'),'utf8'));assert.equal(client.pass,true);assert.equal(client.launchExitCode,0);assert.equal(client.cases.length,2);assert.equal(client.signedInstalledTrust,false);assert.equal(client.productionObservationUnchanged,true);
 for(const key of ['productionChanged','providerUsed','phoneTouched'])assert.equal(client[key],false);
 const identities=new Map();
 function remember(facts,sid,session,query=false){assert.equal(facts.sid,sid);assert.equal(facts.sessionId,session);assert.equal(facts.integrityRid,8192);assert.equal(facts.elevated,false);assert.equal(facts.enabledAdministrators,false);if(query)assert.equal(facts.queryOnlyAuthorityVerified,true);assert.ok(Number.isSafeInteger(facts.pid)&&facts.pid>0);assert.match(facts.createdTicks,/^\d{10,20}$/);pids.add(facts.pid);const k=facts.pid+'/'+facts.createdTicks;if(identities.has(k))assert.deepEqual(identities.get(k),{sid,session});else identities.set(k,{sid,session});}
 for(const round of summary.rounds){
  const control=round.controlNode.ownerBootstrap,executor=round.executorNode.ownerBootstrap,proof=client.cases[round.round-1];
  for(const [role,r]of [['control',control],['executor',executor]]){assert.equal(r.pass,true);assert.equal(r.round,round.round);assert.equal(r.role,role);assert.equal(r.actualNative,true);assert.equal(r.installedTrust,false);assert.equal(r.productionCredentialsRead,false);}
  assert.equal(control.completions,4);assert.equal(control.rollbacks,1);assert.equal(control.inspections,5);assert.equal(control.starts,7);assert.equal(control.listenerInspections,7);assert.equal(control.issues,round.round===1?3:4);assert.equal(control.revocations,control.issues);assert.equal(control.publicationWithdrawn,true);assert.equal(control.signingFileRemoved,true);
  assert.equal(control.peers.length,5);assert.equal(control.peerProofs.length,5);assert.equal(control.nativeFacts.length,5);assert.equal(control.servers.length,7);assert.equal(control.cliPeers.length,control.issues);
  const ids=new Set();for(const p of control.peers){remember(p.facts,manifest.requestorSid,manifest.ownerSessionId,true);assert.match(p.requestId,/^[a-f0-9]{32}$/);assert.equal(ids.has(p.requestId),false);ids.add(p.requestId);assert.ok(Number.isSafeInteger(p.requestExpiresAtUnixMs));}
  for(const f of [...control.servers,...control.cliServers,...control.nativeFacts])remember(f,sids.control,0);
  for(const w of control.peerProofs){assert.equal(w.kind,'peer-identity');remember(w.facts,manifest.requestorSid,manifest.ownerSessionId,true);remember(w.serviceFacts,sids.control,0);}
  for(const f of control.cliPeers)remember(f,manifest.requestorSid,manifest.ownerSessionId,true);
  assert.equal(control.recoveryNoAuthority,true);assert.equal(proof.recoveryNoAuthority,true);assert.equal(proof.recoveredWithoutRestart,true);assert.ok(proof.recoveryDeadline>proof.newDeadline);assert.equal(control.cases[4].deadline,proof.recoveryDeadline);assert.equal(control.cases[4].freshOwner,true);assert.equal(proof.round,round.round);assert.equal(proof.pass,true);assert.equal(proof.idleNoAuthority,true);assert.equal(proof.retiredPipeRefused,true);assert.equal(proof.firstDeadline,proof.reusedDeadline);assert.ok(proof.newDeadline>proof.firstDeadline);assert.equal(proof.issues,control.issues);assert.equal(proof.revocations,control.revocations);assert.equal(proof.fault,round.round===1?'receipt-missing':'commit-abort');assert.equal(proof.racedCookieRevoked,round.round===2);
  for(const f of proof.serverPeers)remember(f,sids.control,0,true);
  assert.deepEqual(executor.cases.map(v=>v.stage),['initial','idle','first','second',...round.round===2?['fault-issued']:[],'recovered']);
  for(const item of executor.cases){assert.equal(item.denials.length,['first','second','recovered'].includes(item.stage)?2:1);for(const d of item.denials)assert.ok(['EACCES','EPERM'].includes(d.code));}
  assert.equal(control.cases[0].noAuthority,true);assert.equal(control.cases[1].unchanged,true);assert.equal(control.cases[2].newDeadline,proof.newDeadline);assert.equal(control.cases[3].revoked,true);
  for(const dir of ['handoff/control','handoff/executor','control/inbox'])for(const stage of activationStages)for(const suffix of ['.json','.json.tmp'])await assert.rejects(lstat(join(protectedRoot,dir,`r${round.round}-activation-${stage}${suffix}`)),{code:'ENOENT'});
  const config=join(protectedRoot,'state/control',`owner-auth-r${round.round}/config`);for(const name of ['owner-bootstrap-cli-live.json','owner-bootstrap-browser-live.json','owner-bootstrap-publisher.json'])for(const suffix of ['','.publisher-lock'])await assert.rejects(lstat(join(config,name+suffix)),{code:'ENOENT'});await assert.rejects(lstat(join(config,'auth-session-secret')),{code:'ENOENT'});
 }
 assert.equal(summary.activationHandoffRemoved,true);assert.equal(summary.ownerPublicationRemoved,true);return {before,after,unchangedAtObservationPoints:true,actualNativeActivation:true,actualOwnerPeerRequeried:true,installedTrust:false,identities:identities.size,issues:7,revocations:7,executorDenials:17};
}
