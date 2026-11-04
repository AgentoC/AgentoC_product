// Private control-parent lifecycle. Callers must already trust installer metadata
// and protect the publication directory with actual control/admin-only write ACLs.
import {open,lstat,realpath,link,unlink} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {renameWithWindowsRetry} from './windows-file-replace.mjs';
import {OWNER_BOOTSTRAP_INSTALLED_PATHS,validateOwnerDiscoveryEvidence} from './windows-owner-discovery.mjs';
import {serveOwnerBootstrapOnce,serveOwnerBrowserBootstrapOnce} from './windows-owner-bootstrap.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const hash=value=>createHash('sha256').update(value).digest('hex');
const typed=error=>/^OBP_[A-Z_]+$/.test(error?.code||'')?error:Object.assign(new Error('OBP_STORAGE_FAILED'),{code:'OBP_STORAGE_FAILED'});
async function safeParent(file){
  for(let path=dirname(file);;path=dirname(path)){
    const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink()||(await realpath(path)).toLowerCase()!==path.toLowerCase())fail('OBP_PATH_INVALID');
    if(dirname(path)===path)break;
  }
}
async function readSingle(file){
  let handle;
  try{
    const before=await lstat(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>8192)fail('OBP_FILE_INVALID');
    handle=await open(file,'r');const after=await handle.stat();
    if(!after.isFile()||after.nlink!==1||after.size>8192||before.ino!==after.ino||before.dev!==after.dev)fail('OBP_FILE_INVALID');
    return await handle.readFile('utf8');
  }catch(error){if(error.code==='ENOENT')return null;throw error;}finally{await handle?.close();}
}

// One exclusive, non-reclaimed publisher lock across processes. A stale lock or
// live file after crash requires separate verified recovery; never guess by PID.
export function createOwnerDiscoveryFileStore({filePath=OWNER_BOOTSTRAP_INSTALLED_PATHS.live}={}){
  if(typeof filePath!=='string'||!filePath.trim())fail('OBP_PATH_INVALID');
  const fixed=resolve(filePath),lockPath=fixed+'.publisher-lock';
  return Object.freeze({async acquire(){
    let lock,ownBytes=null,closed=false,queue=Promise.resolve();
    const serial=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
    try{
      await safeParent(fixed);
      try{lock=await open(lockPath,'wx',0o600);}catch(error){if(error.code==='EEXIST')fail('OBP_ALREADY_OWNED');throw error;}
      await lock.writeFile(JSON.stringify({version:1,publisherId:randomUUID(),pid:process.pid})+'\n');await lock.sync();
      if(await readSingle(fixed)!==null)fail('OBP_EXISTING_DESCRIPTOR');
    }catch(error){if(lock){await lock.close();await unlink(lockPath);}throw typed(error);}
    async function original(){
      if(closed)fail('OBP_STORE_CLOSED');await safeParent(fixed);
      const current=await readSingle(fixed);if(current!==ownBytes)fail('OBP_STATE_CHANGED');
    }
    return Object.freeze({
      publish(record){return serial(async()=>{
        let temporary;
        try{
          await original();const bytes=JSON.stringify(record)+'\n';if(Buffer.byteLength(bytes)>8192)fail('OBP_FILE_INVALID');
          temporary=fixed+'.tmp-'+randomUUID();const file=await open(temporary,'wx',0o600);
          try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
          if(ownBytes===null){await link(temporary,fixed);ownBytes=bytes;await unlink(temporary);temporary=null;}
          else{await renameWithWindowsRetry(temporary,fixed);ownBytes=bytes;temporary=null;}
        }catch(error){throw typed(error);}finally{if(temporary)await unlink(temporary).catch(()=>{});}
      });},
      withdraw(){return serial(async()=>{try{await original();if(ownBytes!==null){await unlink(fixed);ownBytes=null;}}catch(error){throw typed(error);}});},
      close(){return serial(async()=>{
        if(closed)return;
        try{
          await original();if(ownBytes!==null){await unlink(fixed);ownBytes=null;}
          const actual=await lstat(lockPath),held=await lock.stat();
          if(!actual.isFile()||actual.isSymbolicLink()||actual.nlink!==1||actual.ino!==held.ino||actual.dev!==held.dev)fail('OBP_LOCK_CHANGED');
          await lock.close();lock=null;await unlink(lockPath);closed=true;
        }catch(error){throw typed(error);}
      });},
    });
  }});
}

// Structural reuse only: private release/installation inputs are assumed to have
// been verified by the installed OS trust inspector/installer, not by this builder.
export function ownerDiscoveryDescriptor({releaseJson,installationJson,policy,peer},{clock=Date.now}={}){
  let release;try{release=JSON.parse(releaseJson);}catch{fail('OBP_METADATA_INVALID');}
  const descriptor={version:1,policy:structuredClone(policy),peer:structuredClone(peer),releaseSha256:hash(releaseJson),installationSha256:hash(installationJson)};
  try{validateOwnerDiscoveryEvidence({...release.version===2?{version:2,trustMode:release.trustMode}:{version:1,signatureStatus:'Valid',publisherSha256:release.publisherSha256},aclVerified:true,helperSha256:release.helperSha256,
    releaseJson,installationJson,liveJson:JSON.stringify(descriptor),ownerSid:policy.ownerSid,ownerSessionId:policy.ownerSessionId},{clock});}
  catch{fail('OBP_DESCRIPTOR_INVALID');}
  return descriptor;
}
async function boundedClose(promise){
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('OBP_CLOSE_UNCONFIRMED'),{code:'OBP_CLOSE_UNCONFIRMED'})),2000);})]);}
  finally{clearTimeout(timer);}
}
export async function createOwnerDiscoveryController({releaseJson,installationJson,store=createOwnerDiscoveryFileStore(),
  issueOwnerSession,revokeOwnerSession,issueBrowserTicket,revokeBrowserTicket,confirmBrowserTicket,serveEndpoint,executablePath=OWNER_BOOTSTRAP_INSTALLED_PATHS.helper,clock=Date.now}={}){
  const sessionReady=typeof issueOwnerSession==='function'&&typeof revokeOwnerSession==='function',browserReady=typeof issueBrowserTicket==='function'&&typeof revokeBrowserTicket==='function'&&typeof confirmBrowserTicket==='function';
  if((!sessionReady&&!browserReady)||typeof store?.acquire!=='function')fail('OBP_CONFIGURATION_REQUIRED');
  let release;try{release=JSON.parse(releaseJson);}catch{fail('OBP_METADATA_INVALID');}
  const lease=await store.acquire();let active=null,closed=false,queue=Promise.resolve();
  const serial=fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
  async function retire(){
    const previous=active;active=null;
    if(previous?.endpoint){previous.admitted=false;const stop=previous.endpoint.close();stop.catch(()=>{});
      // Remove publication without waiting for a potentially blocked issuer.
      try{await lease.withdraw();await boundedClose(stop);}catch(error){active=previous;throw error;}
    }else await lease.withdraw();
  }
  async function launch(policy){
    if(closed)fail('OBP_CONTROLLER_CLOSED');
    const candidate={admitted:false,ended:false,endpoint:null};active=candidate;
    try{
      const browser=policy.protocolVersion===2&&policy.purpose==='browser';
      if(browser?!browserReady:!sessionReady)fail('OBP_CONFIGURATION_REQUIRED');
      const issue=browser?issueBrowserTicket:issueOwnerSession,revoke=browser?revokeBrowserTicket:revokeOwnerSession;
      const guardedIssue=async(facts,binding)=>{
          if(!candidate.admitted||active!==candidate||clock()>=policy.expiresAtUnixMs)fail('OBP_NOT_PUBLISHED');
          if(policy.protocolVersion===2&&(!binding||binding.instanceId!==policy.instanceId||binding.requestId!==policy.requestId
            ||binding.purpose!==policy.purpose||binding.expiresAtUnixMs!==policy.expiresAtUnixMs||!/^[a-f0-9]{64}$/.test(binding.launchNonce||'')))fail('OBP_BINDING_MISMATCH');
          const token=await issue(facts,binding);
          if(!candidate.admitted||active!==candidate||clock()>=policy.expiresAtUnixMs){if(token)await revoke(token);fail('OBP_RETIRED_DURING_ISSUE');}
          return token;
      };
      candidate.endpoint=await (serveEndpoint||(browser?serveOwnerBrowserBootstrapOnce:serveOwnerBootstrapOnce))({policy,executablePath,executableSha256:release.helperSha256,
        ...browser?{issueBrowserTicket:guardedIssue,revokeBrowserTicket,confirmBrowserTicket}:{issueOwnerSession:guardedIssue,revokeOwnerSession}});
      if(!['protectedDacl','firstInstance','rejectRemote'].every(key=>candidate.endpoint.ready?.[key]===true))fail('OBP_ENDPOINT_UNSAFE');
      const descriptor=ownerDiscoveryDescriptor({releaseJson,installationJson,policy,peer:candidate.endpoint.ready.facts},{clock});
      const completion=candidate.endpoint.completion.then(async value=>{candidate.ended=true;candidate.admitted=false;if(active===candidate)await lease.withdraw();return value;},async error=>{
        candidate.ended=true;candidate.admitted=false;if(active===candidate)await lease.withdraw();throw error;
      });completion.catch(()=>{});
      await lease.publish(descriptor);
      // A pre-publication endpoint failure must not leave a dead advertised pipe.
      if(candidate.ended){await lease.withdraw();fail('OBP_ENDPOINT_ENDED');}
      candidate.admitted=true;
      return Object.freeze({descriptor,ready:candidate.endpoint.ready,self:candidate.endpoint.self,issuer:candidate.endpoint.issuer,completion,
        isActive:()=>active===candidate&&candidate.admitted&&!candidate.ended&&!closed});
    }catch(error){candidate.admitted=false;try{await retire();}catch{}throw error;}
  }
  return Object.freeze({
    start(policy){return serial(async()=>{if(active)fail('OBP_ALREADY_STARTED');return launch(structuredClone(policy));});},
    refresh(policy){return serial(async()=>{if(closed)fail('OBP_CONTROLLER_CLOSED');await retire();return launch(structuredClone(policy));});},
    close(){return serial(async()=>{if(closed)return;await retire();await lease.close();closed=true;});},
  });
}
