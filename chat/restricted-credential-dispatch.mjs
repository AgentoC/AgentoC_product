// Called only after the native private channel authenticates the control peer.
import {controlRunSnapshotHash} from './restricted-control-run-broker.mjs';
import {createRestrictedRunIpcReceiver} from './restricted-run-ipc.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fields=['instanceId','leaseId','runId','requestId','grantId','authorityHash','expiresAtUnixMs'];
export function createCredentialDispatchReceiver({binding,claims,clock=Date.now}){
  if(typeof claims?.consume!=='function')fail('CD_CLAIMS_REQUIRED');let used=false;
  return Object.freeze({async accept(value,execute){
    if(used)fail('CD_ALREADY_USED');
    if(!exact(value,['version','operation','policy','frame','snapshot','snapshotHash','credential'])||value.version!==1||value.operation!=='run.dispatch'
      ||Buffer.byteLength(JSON.stringify(value))>262144)fail('CD_ENVELOPE_INVALID');
    const snapshot=value.snapshot,credential=value.credential;
    if(!exact(snapshot,['version','instanceId','runId','leaseId','providerIdHash','authIdHash','providerRevision','authRevision','harness','protocol','baseUrl','model','endpointPolicyRevision','expiresAtUnixMs'])
      ||snapshot.version!==1||snapshot.harness!=='claude'||snapshot.protocol!=='anthropic-messages'
      ||!['providerIdHash','authIdHash'].every(key=>/^[a-f0-9]{64}$/.test(snapshot[key]||''))
      ||!['providerRevision','authRevision'].every(key=>/^[a-f0-9]{16}$/.test(snapshot[key]||''))
      ||!['model','endpointPolicyRevision'].every(key=>typeof snapshot[key]==='string'&&snapshot[key].length>0&&snapshot[key].length<=200)
      ||!fields.every(key=>value.policy?.[key]===binding[key])
      ||!['instanceId','runId','leaseId','expiresAtUnixMs'].every(key=>snapshot[key]===binding[key])
      ||controlRunSnapshotHash(snapshot)!==value.snapshotHash)fail('CD_SNAPSHOT_INVALID');
    let url;try{url=new URL(snapshot.baseUrl);}catch{fail('CD_ENDPOINT_INVALID');}
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)fail('CD_ENDPOINT_INVALID');
    if(!exact(credential,['authType','apiKey'])||credential.authType!=='api-key'||typeof credential.apiKey!=='string'
      ||!credential.apiKey||Buffer.byteLength(credential.apiKey)>8192||/[\x00-\x1f\x7f]/.test(credential.apiKey))fail('CD_CREDENTIAL_INVALID');
    const receiver=createRestrictedRunIpcReceiver(value.policy,{clock});used=true;
    const outcome=await receiver.accept(value.frame,async bound=>{
      await claims.consume({version:1,instanceId:binding.instanceId,runId:binding.runId,leaseId:binding.leaseId,requestId:binding.requestId,
        grantId:binding.grantId,authorityHash:binding.authorityHash,snapshotHash:value.snapshotHash,textSha256:controlRunSnapshotHash(value.frame.payload.text),
        expiresAtUnixMs:binding.expiresAtUnixMs,state:'consumed-before-credential'});
      return execute({binding:bound,text:value.frame.payload.text,snapshot:Object.freeze({...snapshot}),apiKey:credential.apiKey});
    });return {snapshotHash:value.snapshotHash,outcome};
  }});
}
