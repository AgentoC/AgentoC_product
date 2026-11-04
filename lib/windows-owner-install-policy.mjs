// Installer preparation only. No service changes, authority issuance or writes.
import {isOwnerBootstrapInstanceId} from './windows-owner-bootstrap-protocol.mjs';
import {OWNER_BOOTSTRAP_INSTALLED_PATHS,OWNER_INSTANCE_ROOT} from './windows-owner-discovery.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const serviceSid=v=>typeof v==='string'&&/^S-1-5-80-(?:\d+-){4}\d+$/.test(v)&&!/[\r\n]/.test(v);
export function prepareOwnerInstallPolicy(input){
  if(!OWNER_INSTANCE_ROOT||!exact(input,['instanceId','ownerSid','controlSid','executorSid'])||!isOwnerBootstrapInstanceId(input.instanceId)
    ||typeof input.ownerSid!=='string'||!/^S-1-5-21-(?:\d+-){3}\d+$/.test(input.ownerSid)||/[\r\n]/.test(input.ownerSid)
    ||!serviceSid(input.controlSid)||!serviceSid(input.executorSid)||input.controlSid===input.executorSid)fail('OIP_POLICY_INVALID');
  // Preserve the durable product ID. No UUID/key creation, PATH or usernames.
  const policy=Object.freeze({version:1,instanceId:input.instanceId,controlSid:input.controlSid,
    executorSid:input.executorSid,ownerSid:input.ownerSid,port:7690});
  return Object.freeze({policy,installationPath:OWNER_BOOTSTRAP_INSTALLED_PATHS.installation,
    runtimeDirectory:`${OWNER_INSTANCE_ROOT}/runtime`,mutationPerformed:false,
    migrationReady:false,servicesActivated:false});
}
