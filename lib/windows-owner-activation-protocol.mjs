// Private native-parent activation protocol. No credential-bearing frame exists.
import {isOwnerBootstrapInstanceId} from './windows-owner-bootstrap-protocol.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
export const activationExact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function validateOwnerActivationPolicy(policy){
  if(!activationExact(policy,['domain','instanceId','controlSid','ownerSid','ownerSessionId'])||policy.domain!=='owner.activation.v1'
    ||!isOwnerBootstrapInstanceId(policy.instanceId)||!/^S-1-5-80-(?:\d+-){4}\d+$/.test(policy.controlSid)
    ||!/^S-1-5-21-(?:\d+-){3}\d+$/.test(policy.ownerSid)||/[\r\n]/.test(policy.ownerSid+policy.controlSid)||!Number.isSafeInteger(policy.ownerSessionId)
    ||policy.ownerSessionId<0||policy.ownerSessionId>65535)fail('OBC_ACTIVATION_POLICY_INVALID');
  return Object.freeze({...policy});
}
export function validateOwnerActivationRequest(event,policy,{clock=Date.now}={}){
  validateOwnerActivationPolicy(policy);
  const f=event?.facts,r=event?.frame;
  if(event?.kind!=='request'||!f||f.sid!==policy.ownerSid||!Number.isSafeInteger(f.sessionId)||f.sessionId<=0||f.sessionId>65535
    ||(policy.ownerSessionId!==0&&f.sessionId!==policy.ownerSessionId)||!Number.isSafeInteger(f.pid)||f.pid<=0
    ||typeof f.createdTicks!=='string'||!/^\d{10,20}$/.test(f.createdTicks)||f.integrityRid!==8192||f.elevated!==false
    ||f.enabledAdministrators!==false||f.queryOnlyAuthorityVerified!==true)fail('OBC_PEER_IDENTITY_DENIED');
  if(!activationExact(r,['version','operation','instanceId','requestId','expiresAtUnixMs','challenge','launchNonce'])
    ||r.version!==1||r.operation!=='owner.activation.request'||r.instanceId!==policy.instanceId
    ||typeof r.requestId!=='string'||r.requestId.length!==32||!/^[a-f0-9]{32}$/.test(r.requestId)
    ||typeof r.challenge!=='string'||r.challenge.length!==43||!/^[A-Za-z0-9_-]{43}$/.test(r.challenge)||typeof r.launchNonce!=='string'||r.launchNonce.length!==64||!/^[a-f0-9]{64}$/.test(r.launchNonce)
    ||!Number.isSafeInteger(r.expiresAtUnixMs)||r.expiresAtUnixMs<=clock()||r.expiresAtUnixMs>clock()+30000)fail('OBC_ACTIVATION_REQUEST_INVALID');
  return Object.freeze({facts:Object.freeze({...f}),frame:Object.freeze({...r})});
}
