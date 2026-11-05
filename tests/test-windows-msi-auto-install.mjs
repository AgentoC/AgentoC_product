import { strict as assert } from 'node:assert';
import { prepareSemanticApproval, authorizeWindowsMSIAutomaticInstall } from '../chat/semantic-approval.mjs';
const binding={sessionId:'session-1',runId:'run-1',turnId:'turn-1',requestKey:'request-1'};
const provider={ async realpath(x){return x}, async stat(x){return {type:x.endsWith('.msi')?'file':'dir',identity:x,mountId:'G',size:10}}, async artifactFacts(){return {exists:true,identity:'identity-1',digest:'a'.repeat(64)}} };
const prepare=(command, facts=provider)=>prepareSemanticApproval({request:{...binding,rawCommand:command,executionClass:'host',tool:'approved-action',commandForm:'argv'},trustedContext:{cwd:'G:\\work',projectRoot:'G:\\work',home:'G:\\home',platform:'win32'},resolverOptions:{windowsFactsProvider:facts}});
const prepared=await prepare('msiexec /i G:\\work\\test.msi /qn /norestart');
assert.equal(prepared.projection.decisions[0].decision,'ASK');
assert.equal(prepared.projection.decisions[0].operation.target.digest,'a'.repeat(64));
for (const riskMode of ['recommended','full-auto']) assert.equal(authorizeWindowsMSIAutomaticInstall({prepared,riskMode,kid:'key-1'}).adapter,'windows-msi-install/v1');
assert.throws(()=>authorizeWindowsMSIAutomaticInstall({prepared,riskMode:'cautious',kid:'key-1'}));
const bad=await prepare('msiexec /i G:\\work\\test.msi /qn /norestart /x');
assert.notEqual(bad.projection.decisions[0]?.decision,'ASK');
const missing=await prepare('msiexec /i G:\\work\\test.msi', {...provider, artifactFacts:async()=>null});
assert.notEqual(missing.projection.decisions[0]?.decision,'ASK');
console.log('MSI semantic authorization passed');
const { generateKeyPairSync, createHash, verify } = await import('node:crypto');
const { createWindowsPrivilegedBrokerClient } = await import('../chat/windows-privileged-broker.mjs');
const { submitOrResumeWindowsMSIInstall, msiGrantBytes } = await import('../chat/windows-msi-auto-install.mjs');
const { tryWindowsManagedAutoInstall } = await import('../chat/windows-managed-auto-install.mjs');
const { buildClaudeWindowsInstallBridge } = await import('../chat/windows-auto-install-bridge.mjs');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
let saved, calls=0, inspected=0;
const goJSON = (value) => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
const hash = value => createHash('sha256').update(value).digest('hex');
const broker = createWindowsPrivilegedBrokerClient({platform:'win32',pipeExchange:async ({request})=>{
 if(request.type==='health') return {type:'health',msiInstallReady:true,autoInstallKeyId:'key-1',installationId:'broker-1',policyGeneration:1};
 if(request.type==='status') return saved || {type:'result',requestId:request.requestId,code:'REQUEST_NOT_FOUND'};
 if(request.type==='msi_install.inspect') { inspected++; return {type:'msi_install_inspection',msiFacts:{...request.msiInspect,publisherSha256:'b'.repeat(64)}}; }
 if(request.type==='msi_install.execute') {
  calls++; const g=request.msiInstall; const bytes=msiGrantBytes(g);
  assert.ok(verify(null,bytes,publicKey,Buffer.from(request.signature,'base64url')));
  saved={type:'result',requestId:g.requestId,status:'executing',msiDigest:hash(bytes),msiBinding:hash(goJSON([g.requestId,g.sessionId,g.runId,g.turnId,g.actionId,g.artifactPath,g.artifactSha256]))}; return saved;
 }
 throw Error(request.type);
}});
const opts={client:broker,prepared,riskMode:'recommended',kid:'key-1',privateKey,assertActive:async()=>{}};
assert.equal((await submitOrResumeWindowsMSIInstall({...opts,preflight:true})).ready,true);
assert.equal(calls,0);
assert.equal((await submitOrResumeWindowsMSIInstall(opts)).status,'executing');
assert.equal((await submitOrResumeWindowsMSIInstall(opts)).duplicate,true);
assert.equal(calls,1); assert.equal(inspected,2);
const changed=await prepare('msiexec /i G:\\work\\other.msi');
await assert.rejects(()=>submitOrResumeWindowsMSIInstall({...opts,prepared:changed}), {code:'MSI_INSTALL_BINDING_CONFLICT'});
const managed=await tryWindowsManagedAutoInstall({actions:[{command:'msiexec /i G:\\work\\test.msi'}],binding:{...binding,authenticatedPrincipalKind:'owner'},riskMode:'recommended',trustedContext:{},platform:'win32'}, {prepare:async()=>prepared,getKey:async()=>({kid:'key-1',privateKey}),client:broker,assertActive:async()=>{}});
assert.equal(managed.duplicate,true);
const bridge=buildClaudeWindowsInstallBridge({approval:{approvalId:'approval-1',providerMethod:'can_use_tool',params:{tool_name:'PowerShell',input:{command:'msiexec /i .\\test.msi /qn'}}},state:{windowsManagedActionChannel:{},riskMode:'recommended'},runId:'run-1',nodePath:'G:\\node.exe',scriptPath:'G:\\bridge.mjs'});
assert.ok(bridge?.updatedCommand);
console.log('MSI control-plane submission and replay passed');
