import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRestrictedRunIpcGrant, createRestrictedRunIpcReceiver } from '../chat/restricted-run-ipc.mjs';

const seed = () => ({ instanceId: 'candidate-instance', lease: { version: 1,
  leaseId: randomUUID(), runId: 'run_appapi_0123456789abcdef', requestId: 'request-1',
  grantId: 'rtg_0123456789abcdef', authorityHash: 'a'.repeat(64), expiresAtUnixMs: Date.now()+10000 } });
const outcome = binding => ({ ...binding, stopped: true, completed: true, text: 'SCOPED_RESULT' });

test('private receiver policy preserves sender text, scope, one use and expiry', async () => {
  const input=seed(),sender=createRestrictedRunIpcGrant(input);
  assert.throws(()=>sender.receiverPolicy(),{code:'RESTRICTED_IPC_PAYLOAD_INVALID'});
  const frame=sender.frame('Original task'),policy=sender.receiverPolicy();
  const receiver=createRestrictedRunIpcReceiver(JSON.parse(JSON.stringify(policy)));
  await assert.rejects(receiver.accept({...frame,payload:{text:'Substituted'}},()=>assert.fail()),{code:'RESTRICTED_IPC_PAYLOAD_INVALID'});
  await assert.rejects(receiver.accept({...frame,runId:'run_another_12345678'},()=>assert.fail()),{code:'RESTRICTED_IPC_SCOPE_INVALID'});
  assert.equal((await receiver.accept(frame,async binding=>outcome(binding))).text,'SCOPED_RESULT');
  await assert.rejects(receiver.accept(frame,()=>assert.fail()),{code:'RESTRICTED_IPC_ALREADY_USED'});
  assert.throws(()=>createRestrictedRunIpcReceiver({...policy,command:'cmd.exe'}),{code:'RESTRICTED_IPC_BINDING_INVALID'});
  assert.throws(()=>createRestrictedRunIpcReceiver({...policy,capability:''}),{code:'RESTRICTED_IPC_CAPABILITY_INVALID'});
  assert.throws(()=>createRestrictedRunIpcReceiver({...policy,expiresAtUnixMs:Date.now()+180000}),{code:'RESTRICTED_IPC_BINDING_INVALID'});
  assert.throws(()=>createRestrictedRunIpcReceiver(policy,{clock:()=>policy.expiresAtUnixMs}),{code:'RESTRICTED_IPC_BINDING_INVALID'});
});

test('Run IPC is one use across concurrent delivery and worker failure', async () => {
  const grant = createRestrictedRunIpcGrant(seed()), frame = grant.frame('Calculate a result'); let calls = 0;
  const execute = async binding => { calls++; await new Promise(done => setTimeout(done,10)); return outcome(binding); };
  const results = await Promise.allSettled([grant.accept(frame,execute),grant.accept(frame,execute)]);
  assert.equal(calls,1); assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.find(x=>x.status==='rejected').reason.code,'RESTRICTED_IPC_ALREADY_USED');
  const failed = createRestrictedRunIpcGrant(seed()), failedFrame = failed.frame('Input');
  await assert.rejects(failed.accept(failedFrame,async()=>{ throw new Error('worker disconnected'); }));
  await assert.rejects(failed.accept(failedFrame,execute),{code:'RESTRICTED_IPC_ALREADY_USED'});
});

test('Owner operations, cross Run/instance/grant and invalid capability never dispatch', async () => {
  for (const patch of [{operation:'owner.session'},{runId:'run_different_123'}, {instanceId:'other'},
    {grantId:'rtg_different_123'}, {leaseId:randomUUID()}, {requestId:'other'}, {authorityHash:'b'.repeat(64)},
    {capability:'x'.repeat(43)}, {command:'cmd.exe'}, {payload:{text:'Changed message'}}, {payload:{text:'hi',env:{SECRET:'bad'}}}]) {
    const grant = createRestrictedRunIpcGrant(seed()); let calls=0;
    await assert.rejects(grant.accept({...grant.frame('Input'),...patch},async b=>{calls++;return outcome(b);}));
    assert.equal(calls,0);
    assert.throws(()=>grant.frame('A different task'),{code:'RESTRICTED_IPC_PAYLOAD_INVALID'});
    await grant.accept(grant.frame('Input'),async b=>outcome(b));
  }
});

test('expired/deadline extension and oversized input fail before dispatch', async () => {
  let now = Date.now(); const input = seed(); input.lease.expiresAtUnixMs=now+100;
  const grant = createRestrictedRunIpcGrant({...input,clock:()=>now}),frame=grant.frame('Input');
  input.lease.expiresAtUnixMs=now+100000; // caller mutation cannot extend the frozen deadline
  now+=101; await assert.rejects(grant.accept(frame,()=>assert.fail()),{code:'RESTRICTED_IPC_EXPIRED'});
  assert.throws(()=>createRestrictedRunIpcGrant({...seed(),lease:{...seed().lease,expiresAtUnixMs:Date.now()+180000}}));
  assert.throws(()=>createRestrictedRunIpcGrant(seed()).frame('x'.repeat(65537)));
});

test('outcomes cannot cross Run or claim unknown stop and expired results are rejected', async () => {
  for (const patch of [{runId:'run_different_123'}, {stopped:false}, {completed:'yes'},
    {text:'x'.repeat(65537)}, {ownerToken:'forbidden'}]) {
    const grant=createRestrictedRunIpcGrant(seed());
    await assert.rejects(grant.accept(grant.frame('Input'), async b=>({...outcome(b),...patch})),{code:'RESTRICTED_IPC_OUTCOME_INVALID'});
  }
  let now=Date.now(); const input=seed(); input.lease.expiresAtUnixMs=now+100;
  const grant=createRestrictedRunIpcGrant({...input,clock:()=>now});
  await assert.rejects(grant.accept(grant.frame('Input'),async b=>{now+=101;return outcome(b);}),{code:'RESTRICTED_IPC_EXPIRED'});
});
