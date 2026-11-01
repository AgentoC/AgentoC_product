// Read-only installed trust boundary. No PATH/env overrides, IPC or session minting.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateOwnerBootstrapPolicy} from './windows-owner-bootstrap-protocol.mjs';
import {ownerTrustFields,validOwnerTrustFacts,validOwnerReleaseBinding} from './windows-owner-release-trust.mjs';
const exec=promisify(execFile),fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const digest=value=>createHash('sha256').update(value).digest('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export const OWNER_BOOTSTRAP_INSTALLED_ROOT=(process.env.AGENTOC_INSTALL_ROOT||'C:/Program Files/AgentoC').replaceAll('\\','/').replace(/\/+$/,'');
export const OWNER_BOOTSTRAP_INSTALLED_ROOT_WINDOWS=OWNER_BOOTSTRAP_INSTALLED_ROOT.replaceAll('/','\\');
export const OWNER_BOOTSTRAP_INSTALLED_PATHS=Object.freeze({
  helper:`${OWNER_BOOTSTRAP_INSTALLED_ROOT}/payload/AgentoC.OwnerBootstrap.exe`,
  release:`${OWNER_BOOTSTRAP_INSTALLED_ROOT}/payload/owner-bootstrap-release.json`,
  installation:'C:/ProgramData/AgentoC/instances/owner/security/owner-bootstrap-install.json',
  live:'C:/ProgramData/AgentoC/instances/owner/runtime/owner-bootstrap-live.json',
  cliLive:'C:/ProgramData/AgentoC/instances/owner/runtime/owner-bootstrap-cli-live.json',
  browserLive:'C:/ProgramData/AgentoC/instances/owner/runtime/owner-bootstrap-browser-live.json',
  publisher:'C:/ProgramData/AgentoC/instances/owner/runtime/owner-bootstrap-publisher.json',
});
export function ownerDiscoveryPurposePath(purpose){
  if(!['cli','browser'].includes(purpose))fail('OBD_PURPOSE_INVALID');
  return purpose==='cli'?OWNER_BOOTSTRAP_INSTALLED_PATHS.cliLive:OWNER_BOOTSTRAP_INSTALLED_PATHS.browserLive;
}

// Pure interpretation of a PRIVATE OS inspector result, not a public request.
// aclVerified/signature facts must come from inspectInstalledOwnerBootstrap.
export function validateOwnerDiscoveryEvidence(observed,{clock=Date.now,purpose}={}){
  if(purpose!==undefined)ownerDiscoveryPurposePath(purpose);
  if(!exact(observed,['version','aclVerified','helperSha256',...ownerTrustFields(observed),'ownerSid','ownerSessionId','releaseJson','installationJson','liveJson'])
    ||!validOwnerTrustFacts(observed))fail('OBD_INSTALL_TRUST_FAILED');
  let release,installation,live;
  try{
    for(const key of ['releaseJson','installationJson','liveJson'])if(typeof observed[key]!=='string'||Buffer.byteLength(observed[key])>8192)fail('OBD_METADATA_INVALID');
    release=JSON.parse(observed.releaseJson);installation=JSON.parse(observed.installationJson);live=JSON.parse(observed.liveJson);
  }catch{fail('OBD_METADATA_INVALID');}
  if(!validOwnerReleaseBinding(release,observed,{protocols:[1,2]}))fail('OBD_RELEASE_MISMATCH');
  if(!exact(installation,['version','instanceId','controlSid','executorSid','ownerSid','port'])||installation.version!==1
    ||installation.port!==7690||!/^S-1-5-80-(?:\d+-){4}\d+$/.test(installation.executorSid)
    ||installation.executorSid===installation.controlSid)fail('OBD_INSTALL_POLICY_INVALID');
  if(!exact(live,['version','policy','peer','releaseSha256','installationSha256'])||live.version!==1
    ||live.releaseSha256!==digest(observed.releaseJson)||live.installationSha256!==digest(observed.installationJson))fail('OBD_GENERATION_MISMATCH');
  let policy;try{policy=validateOwnerBootstrapPolicy(live.policy,{clock});}catch{fail('OBD_ENDPOINT_POLICY_INVALID');}
  if((policy.protocolVersion??1)!==release.protocolVersion)fail('OBD_RELEASE_MISMATCH');
  if(purpose!==undefined&&(policy.protocolVersion!==2||policy.purpose!==purpose))fail('OBD_PURPOSE_MISMATCH');
  if(!['instanceId','controlSid','ownerSid'].every(key=>policy[key]===installation[key])
    ||policy.ownerSid!==observed.ownerSid||policy.ownerSessionId!==observed.ownerSessionId)fail('OBD_OWNER_MISMATCH');
  const peer=live.peer;
  if(!exact(peer,['pid','createdTicks','sid','sessionId','integrityRid','elevated','enabledAdministrators'])
    ||!Number.isSafeInteger(peer.pid)||peer.pid<=0||typeof peer.createdTicks!=='string'||!/^\d{10,20}$/.test(peer.createdTicks)
    ||peer.sid!==policy.controlSid||peer.sessionId!==0||peer.integrityRid!==8192||peer.elevated!==false||peer.enabledAdministrators!==false)fail('OBD_PEER_PIN_INVALID');
  return Object.freeze({instanceId:policy.instanceId,expiresAtUnixMs:policy.expiresAtUnixMs,baseUrl:'http://127.0.0.1:7690',
    ...(observed.version===2?{trustMode:release.trustMode}:{publisherSha256:release.publisherSha256}),executablePath:OWNER_BOOTSTRAP_INSTALLED_PATHS.helper,
    executableSha256:release.helperSha256,policy:Object.freeze({...policy,peer:Object.freeze({...peer})})});
}

// Cold inbox PowerShell startup alone exceeded 22s on a real hosted Windows OS.
// This is an inspection IO ceiling, never a grant/discovery deadline extension.
export const OWNER_INSPECTION_TIMEOUT_MS=60000;
export async function inspectInstalledOwnerBootstrap({purpose='cli'}={}){
  ownerDiscoveryPurposePath(purpose);
  if(process.platform!=='win32')fail('OBD_PLATFORM_UNSUPPORTED');
  const script=fileURLToPath(new URL('../packaging/windows/read-owner-bootstrap-discovery.ps1',import.meta.url));
  try{
    const {stdout}=await exec('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Purpose',purpose],{windowsHide:true,timeout:OWNER_INSPECTION_TIMEOUT_MS,maxBuffer:65536,
      env:{SystemRoot:'C:/Windows',WINDIR:'C:/Windows',AGENTOC_INSTALL_ROOT:OWNER_BOOTSTRAP_INSTALLED_ROOT_WINDOWS}});
    const observed=JSON.parse(stdout.replace(/^\uFEFF/,''));
    if(observed?.ok===false&&/^OBD_[A-Z_]+$/.test(observed.code))fail(observed.code);
    return validateOwnerDiscoveryEvidence(observed,{purpose});
  }catch(error){if(/^OBD_[A-Z_]+$/.test(error?.code||''))throw error;fail(error?.killed===true?'OBD_INSPECTION_TIMEOUT':'OBD_INSPECTION_FAILED');}
}

export async function collectOwnerBootstrapDiagnostics({platform=process.platform}={}){
  if(platform!=='win32')return {platform,supported:false,status:'unsupported',scope:'owner-bootstrap'};
  try{
    const trusted=await inspectInstalledOwnerBootstrap();
    return {platform,supported:true,status:'ready',scope:'owner-bootstrap',readOnly:true,ownerIpcConnected:false,sessionIssued:false,
      identity:{status:'discovered',instanceId:trusted.instanceId},expiresAtUnixMs:trusted.expiresAtUnixMs};
  }catch(error){return {platform,supported:true,status:'failed',scope:'owner-bootstrap',readOnly:true,ownerIpcConnected:false,sessionIssued:false,
    error:{code:/^OBD_[A-Z_]+$/.test(error?.code||'')?error.code:'OBD_INSPECTION_FAILED',message:'Owner bootstrap is unavailable; verify the administrative installation, file integrity and separated service identities.'}};}
}
