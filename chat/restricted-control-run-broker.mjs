// Private control-parent API, not an HTTP/runner credential-resolution endpoint.
// authority is the original RestrictedRunHost; transport.open authenticates the
// OS peer before returning. Only a selected static Claude API key is supported.
import {createHash,timingSafeEqual} from 'node:crypto';
import {open,lstat,realpath} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {createRestrictedRunIpcGrant} from './restricted-run-ipc.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export const controlRunSnapshotHash=digest;
const equal=(a,b)=>digest(a)===digest(b);
const text=(value,max=256)=>typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=max&&!/[\x00-\x1f\x7f]/.test(value);
const leaseKeys=['version','leaseId','runId','sessionId','requestId','grantId','scope','authorityHash','expiresAtUnixMs'];

// The installer/control parent owns this directory and its ACL. Path checks do
// not establish OS identity separation. Claims are never released/retried here.
export function createControlRunClaims({root}){
  const fixed=resolve(root);
  return Object.freeze({async consume(record){
    const keys=['version','instanceId','runId','leaseId','requestId','grantId','authorityHash','snapshotHash','textSha256','expiresAtUnixMs','state'];
    if(!record||Object.keys(record).length!==keys.length||!keys.every(key=>Object.hasOwn(record,key))
      ||record.version!==1||record.state!=='consumed-before-credential'||!text(record.instanceId,128)
      ||!text(record.runId,200)||!text(record.leaseId,128)||!text(record.requestId,200)||!text(record.grantId,200)
      ||!Number.isSafeInteger(record.expiresAtUnixMs)||!['authorityHash','snapshotHash','textSha256'].every(key=>/^[a-f0-9]{64}$/.test(record[key]||'')))fail('CB_CLAIM_INVALID');
    for(let cursor=fixed;;cursor=dirname(cursor)){
      const stat=await lstat(cursor);
      if(stat.isSymbolicLink()||(await realpath(cursor)).toLowerCase()!==cursor.toLowerCase())fail('CB_CLAIM_ROOT_INVALID');
      if(dirname(cursor)===cursor)break;
    }
    if(!(await lstat(fixed)).isDirectory())fail('CB_CLAIM_ROOT_INVALID');
    const path=join(fixed,digest([record.instanceId,record.runId])+'.json');
    let file;try{file=await open(path,'wx',0o600);}catch(error){if(error.code==='EEXIST')fail('CB_ALREADY_CONSUMED');throw error;}
    try{await file.writeFile(JSON.stringify(record)+'\n');await file.sync();}finally{await file.close();}
  }});
}

export function createRestrictedControlRunBroker({instanceId,executorSid,authority,registry,secretStore,claims,transport,authorizeEndpoint,clock=Date.now}){
  if(!text(instanceId,128)||! /^S-1-5-80-(?:\d+-){4}\d+$/.test(executorSid||'')
    ||typeof authority?.scoped!=='function'||typeof registry?.getProviderProfile!=='function'||typeof registry?.getAuthProfile!=='function'
    ||typeof secretStore?.resolveSecret!=='function'||typeof claims?.consume!=='function'
    ||typeof transport?.open!=='function'||typeof authorizeEndpoint!=='function')fail('CB_CONFIGURATION_REQUIRED');

  async function original(lease,signal){
    if(signal?.aborted)fail('CB_CANCELLED');
    if(!lease||Object.keys(lease).length!==leaseKeys.length||!leaseKeys.every(key=>Object.hasOwn(lease,key))
      ||lease.version!==1||!Number.isSafeInteger(lease.expiresAtUnixMs)||lease.expiresAtUnixMs<=clock()
      ||lease.expiresAtUnixMs>clock()+120000)fail('CB_LEASE_INVALID');
    return authority.scoped(lease,evidence=>{
      const stored=evidence?.run?.restrictedExecution;
      if(!stored||!equal(Object.fromEntries(leaseKeys.map(key=>[key,stored[key]])),lease)
        ||stored.state!=='dispatched'||evidence.run.cancelRequested||evidence.run.state!=='running'
        ||evidence.binding?.principalKind!=='temporary_device'||evidence.record?.request?.attachments?.length!==0
        ||evidence.run.id!==lease.runId||evidence.run.sessionId!==lease.sessionId||evidence.run.requestId!==lease.requestId
        ||evidence.binding.temporaryAuthority?.grantId!==lease.grantId)fail('CB_AUTHORITY_DENIED');
      return structuredClone({record:evidence.record,binding:evidence.binding});
    });
  }
  async function selection(input){
    const config=input.binding.configuration,options=input.record.request.runOptions||{};
    if(config?.tool!=='claude'||(options.tool&&options.tool!=='claude')||!text(config.providerProfile))fail('CB_SELECTION_UNSUPPORTED');
    const profile=await registry.getProviderProfile(config.providerProfile);
    if(!profile||profile.id!==config.providerProfile||profile.agentType!=='claude'||profile.protocol!=='anthropic-messages'
      ||profile.enabled===false||profile.status!=='ready'||! /^[a-f0-9]{16}$/.test(profile.revision||''))fail('CB_PROVIDER_UNAVAILABLE');
    const auth=await registry.getAuthProfile(profile.authProfileId);
    if(!auth||auth.id!==profile.authProfileId||auth.agentType!=='claude'||auth.authType!=='api-key'||auth.storageType!=='secret-store'
      ||! /^[A-Za-z0-9._-]{1,128}$/.test(auth.storageRef||'')||! /^[a-f0-9]{16}$/.test(auth.revision||''))fail('CB_AUTH_UNSUPPORTED');
    const model=options.model||config.model||profile.modelPolicy?.defaultModel;
    if(!text(model,200))fail('CB_MODEL_INVALID');
    if(!text(profile.baseUrl,2048))fail('CB_ENDPOINT_DENIED');
    let url;try{url=new URL(profile.baseUrl);}catch{fail('CB_ENDPOINT_DENIED');}
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)fail('CB_ENDPOINT_DENIED');
    const endpoint=await authorizeEndpoint(url.href);
    if(endpoint?.allowed!==true||!text(endpoint.revision,128))fail('CB_ENDPOINT_DENIED');
    return {profile,auth,model,endpointRevision:endpoint.revision};
  }
  function peer(facts){
    if(!facts||facts.sid!==executorSid||facts.sessionId!==0||facts.integrityRid!==8192||facts.elevated!==false
      ||facts.enabledAdministrators!==false||facts.queryOnlyAuthorityVerified!==true
      ||!Number.isSafeInteger(facts.pid)||facts.pid<=0||! /^\d{10,20}$/.test(facts.createdTicks||''))fail('CB_EXECUTOR_DENIED');
  }
  async function execute({lease:provided,signal}={}){
    let channel,sent=false;
    try{
      const lease=structuredClone(provided),input=await original(lease,signal),chosen=await selection(input);
      const grant=createRestrictedRunIpcGrant({instanceId,lease,clock}),frame=grant.frame(input.record.request.text);
      const snapshot=Object.freeze({version:1,instanceId,runId:lease.runId,leaseId:lease.leaseId,
        providerIdHash:digest(chosen.profile.id),authIdHash:digest(chosen.auth.id),providerRevision:chosen.profile.revision,
        authRevision:chosen.auth.revision,harness:'claude',protocol:chosen.profile.protocol,baseUrl:chosen.profile.baseUrl,
        model:chosen.model,endpointPolicyRevision:chosen.endpointRevision,expiresAtUnixMs:lease.expiresAtUnixMs});
      const snapshotHash=digest(snapshot);
      await claims.consume({version:1,instanceId,runId:lease.runId,leaseId:lease.leaseId,requestId:lease.requestId,
        grantId:lease.grantId,authorityHash:lease.authorityHash,snapshotHash,textSha256:digest(frame.payload.text),
        expiresAtUnixMs:lease.expiresAtUnixMs,state:'consumed-before-credential'});
      channel=await transport.open({binding:grant.binding,signal});peer(channel?.peer);
      if(typeof channel.send!=='function'||typeof channel.close!=='function')fail('CB_CHANNEL_INVALID');
      if(!equal(await original(lease,signal),input)||!equal(await selection(input),chosen))fail('CB_CONFIGURATION_CHANGED');
      const credential=await secretStore.resolveSecret(chosen.auth.storageRef);
      if(credential?.ok!==true||credential.authType!=='api-key'||!text(credential.apiKey,8192))fail('CB_CREDENTIAL_UNAVAILABLE');
      if(!equal(await original(lease,signal),input)||!equal(await selection(input),chosen))fail('CB_CONFIGURATION_CHANGED');
      const current=await secretStore.resolveSecret(chosen.auth.storageRef);
      if(current?.ok!==true||current.authType!=='api-key'||typeof current.apiKey!=='string'
        ||!timingSafeEqual(createHash('sha256').update(current.apiKey).digest(),createHash('sha256').update(credential.apiKey).digest()))fail('CB_CREDENTIAL_CHANGED');
      // The final authority read precedes the synchronous invocation of send.
      // No resolver, secret path, refresh token or caller environment crosses it.
      if(!equal(await selection(input),chosen))fail('CB_CONFIGURATION_CHANGED');
      if(!equal(await original(lease,signal),input))fail('CB_CONFIGURATION_CHANGED');
      const outcome=await grant.accept(frame,async()=>{
        if(signal?.aborted)fail('CB_CANCELLED');
        sent=true;
        const response=await channel.send({version:1,operation:'run.dispatch',policy:grant.receiverPolicy(),frame,
          snapshot,snapshotHash,credential:{authType:'api-key',apiKey:credential.apiKey}},{signal});
        if(!response||Object.keys(response).sort().join(',')!=='outcome,snapshotHash'||response.snapshotHash!==snapshotHash)fail('CB_RESULT_BINDING_INVALID');
        return response.outcome;
      });
      await channel.close();channel=null;
      if(!equal(await original(lease,signal),input))fail('CB_CONFIGURATION_CHANGED');
      return outcome;
    }catch(error){
      const code=/^CB_[A-Z_]+$/.test(error?.code||'')?error.code:sent?'CB_DELIVERY_UNCONFIRMED':'CB_PREPARATION_FAILED';
      throw Object.assign(new Error(code),{code,stopConfirmed:!sent});
    }finally{if(typeof channel?.close==='function'){try{await channel.close();}catch{}}}
  }
  return Object.freeze({execute});
}
