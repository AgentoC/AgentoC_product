import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {credentialProviderWorkerInput} from '../chat/restricted-provider-worker-input.mjs';
import {controlRunSnapshotHash} from '../chat/restricted-control-run-broker.mjs';
const nativeBinding={version:1,instanceId:'instance',leaseId:'lease',runId:'run',requestId:'request',grantId:'grant',authorityHash:'a'.repeat(64),expiresAtUnixMs:Date.now()+30000};
const fields={binding:nativeBinding,text:'CSV 甲乙',apiKey:'synthetic',snapshot:{version:1,...nativeBinding,harness:'claude',protocol:'anthropic-messages',model:'qa',baseUrl:'https://example.test'}};
test('native raw binding bytes equal canonical control snapshot digest; only admitted inputs forwarded',()=>{
  const value=credentialProviderWorkerInput({...fields,env:{UNTRUSTED:'x'},cwd:'ignored',executable:'ignored'},nativeBinding);
  assert.equal(createHash('sha256').update(JSON.stringify(value.provider)).digest('hex'),controlRunSnapshotHash(fields.snapshot));
  assert.equal(value.providerSnapshotHash,controlRunSnapshotHash(fields.snapshot));assert.equal(value.frame.payload.text,fields.text);
  assert.deepEqual(Object.keys(value).sort(),['apiKey','frame','policy','provider','providerSnapshotHash']);assert.ok(Object.isFrozen(value.policy)&&Object.isFrozen(value.provider));
});
test('different Run authority or native deadline cannot enter Provider worker',()=>{
  for(const key of ['leaseId','runId','requestId','grantId','authorityHash','instanceId','expiresAtUnixMs'])
    assert.throws(()=>credentialProviderWorkerInput(fields,{...nativeBinding,[key]:'changed'}),{code:'CP_WORKER_BINDING_INVALID'});
});
test('unsupported protocol and malformed credential fail before worker input construction',()=>{
  for(const value of [{...fields,apiKey:'x\n'},{...fields,apiKey:''},{...fields,snapshot:{...fields.snapshot,protocol:'oauth'}}])
    assert.throws(()=>credentialProviderWorkerInput(value,nativeBinding),{code:'CP_WORKER_BINDING_INVALID'});
});
