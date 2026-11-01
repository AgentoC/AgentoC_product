import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,randomBytes} from 'node:crypto';
import {createRestrictedRunIpcGrant} from '../chat/restricted-run-ipc.mjs';
import {controlRunSnapshotHash} from '../chat/restricted-control-run-broker.mjs';
import {createCredentialDispatchReceiver} from '../chat/restricted-credential-dispatch.mjs';
function fixture(){let now=Date.now(),claims=0,calls=0;
  const lease={version:1,leaseId:randomUUID(),runId:'run_'+randomBytes(16).toString('hex'),requestId:'credential-request',grantId:'rtg_0123456789abcdef',authorityHash:'a'.repeat(64),expiresAtUnixMs:now+10000};
  const grant=createRestrictedRunIpcGrant({instanceId:'isolated',lease}),frame=grant.frame('甲,42');
  const snapshot={version:1,instanceId:'isolated',runId:lease.runId,leaseId:lease.leaseId,providerIdHash:'b'.repeat(64),authIdHash:'c'.repeat(64),providerRevision:'1'.repeat(16),authRevision:'2'.repeat(16),harness:'claude',protocol:'anthropic-messages',baseUrl:'https://example.test/',model:'synthetic',endpointPolicyRevision:'qa-1',expiresAtUnixMs:lease.expiresAtUnixMs};
  const value={version:1,operation:'run.dispatch',policy:structuredClone(grant.receiverPolicy()),frame,snapshot,snapshotHash:controlRunSnapshotHash(snapshot),credential:{authType:'api-key',apiKey:'SYNTHETIC-'+randomBytes(32).toString('hex')}};
  const options={binding:grant.binding,clock:()=>now,claims:{consume:async()=>{if(claims++)throw Object.assign(new Error('consumed'),{code:'CB_ALREADY_CONSUMED'});}}};
  const execute=async fields=>{calls++;assert.equal(fields.text,'甲,42');assert.equal(fields.apiKey,value.credential.apiKey);return {...fields.binding,stopped:true,completed:true,text:'甲:42'};};
  return {value,options,execute,calls:()=>calls,claims:()=>claims,expire:()=>now+=11000};
}
test('bound static credential dispatch executes once; warm and cold receiver replays fail',async()=>{const f=fixture(),r=createCredentialDispatchReceiver(f.options);
  assert.equal((await r.accept(f.value,f.execute)).outcome.text,'甲:42');await assert.rejects(r.accept(f.value,f.execute),{code:'CD_ALREADY_USED'});
  await assert.rejects(createCredentialDispatchReceiver(f.options).accept(f.value,f.execute),{code:'CB_ALREADY_CONSUMED'});assert.equal(f.calls(),1);});
test('Owner operations, arbitrary credential fields, refresh tokens and snapshot additions never execute',async()=>{
  for(const change of [v=>v.operation='owner.session',v=>v.credential.refresh_token='forbidden',v=>v.credential.storageRef='master',v=>v.credential.authType='oauth',v=>v.snapshot.command='cmd.exe',v=>v.snapshotHash='f'.repeat(64)]){
    const f=fixture();change(f.value);await assert.rejects(createCredentialDispatchReceiver(f.options).accept(f.value,f.execute));assert.equal(f.calls(),0);assert.equal(f.claims(),0);}});
test('cross Run/instance/deadline or substituted text never execute',async()=>{
  for(const change of [v=>v.frame.runId='run_other_12345',v=>v.policy.instanceId='other',v=>v.policy.expiresAtUnixMs+=1000,v=>v.frame.payload.text='substituted']){
    const f=fixture();change(f.value);await assert.rejects(createCredentialDispatchReceiver(f.options).accept(f.value,f.execute));assert.equal(f.calls(),0);assert.equal(f.claims(),0);}});
test('expiry and callback failure keep the same one-use fence',async()=>{const f=fixture();f.expire();await assert.rejects(createCredentialDispatchReceiver(f.options).accept(f.value,f.execute));assert.equal(f.calls(),0);
  const g=fixture(),r=createCredentialDispatchReceiver(g.options);await assert.rejects(r.accept(g.value,async()=>{throw new Error('failed task');}));await assert.rejects(r.accept(g.value,g.execute),{code:'CD_ALREADY_USED'});
  await assert.rejects(createCredentialDispatchReceiver(g.options).accept(g.value,g.execute),{code:'CB_ALREADY_CONSUMED'});assert.equal(g.calls(),0);});
