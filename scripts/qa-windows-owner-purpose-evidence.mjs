// Independent cross-check of ordinary Owner and protected service exports.
import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {ownerPurposeScenarios as scenarios,ownerPurposePositive as positives,ownerPurposeDeliveryFailure as failures} from '../tests/fixtures/windows-service-owner-purpose-probe.mjs';
export async function verifyOwnerPurpose({manifest,summary,bundle,protectedRoot,sids,pids}){
  const before=JSON.parse(await readFile(join(bundle,'production-before.json'),'utf8')),after=JSON.parse(await readFile(join(bundle,'production-after.json'),'utf8'));
  assert.deepEqual(after,before);
  const client=JSON.parse(await readFile(join(bundle,'owner-purpose-client.json'),'utf8'));
  assert.equal(client.caseId,manifest.caseId);assert.equal(client.pass,true);assert.equal(client.protocolVersion,2);assert.equal(client.launchExitCode,0);assert.equal(client.cases.length,28);
  for(const key of ['productionChanged','phoneTouched','providerUsed','actualPhoneOrTurn'])assert.equal(client[key],false);
  const endpoints=new Set();
  function remember(facts,sid,session){assert.equal(facts.sid,sid);assert.equal(facts.sessionId,session);assert.equal(facts.integrityRid,8192);assert.equal(facts.elevated,false);assert.equal(facts.enabledAdministrators,false);
    assert.ok(Number.isSafeInteger(facts.pid)&&facts.pid>0);assert.match(facts.createdTicks,/^\d{10,20}$/);const key=facts.pid+'/'+facts.createdTicks;assert.ok(!endpoints.has(key));endpoints.add(key);pids.add(facts.pid);}
  const errors={'browser-purpose':'OBC_OPERATION_DENIED','cli-purpose':'OBC_OPERATION_DENIED','browser-downgrade':'OBC_OPERATION_DENIED','browser-launch-missing':'OBC_FRAME_INVALID',
    'browser-launch-invalid':'OBC_LAUNCH_NONCE_INVALID','browser-instance':'OBC_BINDING_MISMATCH','browser-server-pin':'OBC_PEER_DISCONNECTED','browser-disconnect':'OBC_PEER_DISCONNECTED',
    'browser-delivery-failure':'OBC_DELIVERY_UNCONFIRMED','browser-receipt-nonce':'OBC_DELIVERY_UNCONFIRMED','browser-receipt-purpose':'OBC_DELIVERY_UNCONFIRMED'};
  for(const round of summary.rounds){
    const control=round.controlNode.ownerBootstrap,executor=round.executorNode.ownerBootstrap;
    for(const [role,value]of [['control',control],['executor',executor]]){assert.equal(value.pass,true);assert.equal(value.role,role);assert.equal(value.round,round.round);assert.equal(value.protocolVersion,2);assert.equal(value.productionCredentialsRead,false);assert.deepEqual(value.cases.map(x=>x.scenario),scenarios);}
    for(const key of ['signingKeyNeverInEndpointEnvironment','syntheticOwnerSessionsRevoked','signingFileRemoved'])assert.equal(control[key],true);
    for(const [i,scenario]of scenarios.entries()){
      const proof=client.cases.find(x=>x.round===round.round&&x.scenario===scenario),value=control.cases[i],positive=positives.has(scenario),delivery=failures.has(scenario),received=positive||delivery,browser=!scenario.startsWith('cli-');
      assert.ok(proof);for(const item of [proof,value]){
        for(const key of ['pass','executorDenied','publicationVerified','publicationWithdrawn'])assert.equal(item[key],true,scenario+':'+key);
        assert.equal(item.purpose,browser?'browser':'cli');assert.equal(item.cliIssues,scenario==='cli-success'?1:0);
        assert.equal(item.ticketIssues,browser&&received?1:0);assert.equal(item.cookieIssues,browser&&received?1:0);assert.equal(item.revocations,received?1:0);assert.equal(item.confirmations,browser&&positive?1:0);
        assert.equal(item.nativeError,positive?null:errors[scenario]);
      }
      assert.equal(executor.cases[i].executorDenied,true);assert.equal(proof.anonymousHttpDenied,true);assert.equal(proof.authenticatedHttpAccepted,received);assert.equal(proof.revokedHttpDenied,received);
      assert.equal(proof.nativeReceiptConfirmed,positive);assert.equal(proof.nativeReceiptFailureRevoked,delivery);
      for(const key of ['nonceDenied','ticketNotCookie','ticketReplayDenied'])assert.equal(proof[key],browser&&received,scenario+':'+key);
      remember(proof.server,sids.control,0);
      if(received){assert.deepEqual(proof.owner,value.peer);assert.equal(value.peer.queryOnlyAuthorityVerified,true);assert.equal(value.replayRefused,true);remember(value.peer,manifest.requestorSid,manifest.ownerSessionId);assert.ok(value.validHttp>0);}
      if(scenario==='browser-success'){assert.equal(proof.retiredRefused,true);assert.equal(value.refreshVerified,true);remember(value.retiredEndpoint,sids.control,0);}
      for(const [location,kinds]of [['handoff/control',['ready','done']],['handoff/executor',['denied']],['control/inbox',['ack','finish']]])for(const kind of kinds)for(const suffix of ['.json','.json.tmp'])
        await assert.rejects(lstat(join(protectedRoot,location,`r${round.round}-owner-${scenario}-${kind}${suffix}`)),{code:'ENOENT'});
    }
    const config=join(protectedRoot,'state/control',`owner-auth-r${round.round}/config`);
    for(const name of ['owner-bootstrap-live.json','owner-bootstrap-live.json.publisher-lock','auth-session-secret'])await assert.rejects(lstat(join(config,name)),{code:'ENOENT'});
  }
  assert.equal(summary.ownerHandoffRemoved,true);assert.equal(summary.ownerPublicationRemoved,true);assert.equal(client.productionObservationUnchanged,true);
  return {before,after,unchangedAtObservationPoints:true};
}
