import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
assert.equal(process.platform,'win32');
const root=resolve('.'),evidence=resolve(process.argv[2]||'artifacts/showcase/T2-current-20261020/owner-activation'),bundle=join(evidence,'native-'+randomUUID());await mkdir(bundle,{recursive:true});
const source=join(root,'native/windows-owner-bootstrap.cs'),fixture=join(root,'tests/fixtures/windows-owner-activation-codec.cs'),hash=b=>createHash('sha256').update(b).digest('hex');
const report={pass:false,checks:[],level:'real C# codec with synthetic frames; actual ordinary-process refusals',realControlServicePositive:false,signedInstalledPositive:false,sourceSha256:hash(await readFile(source)),fixtureSha256:hash(await readFile(fixture))};
async function run(exe,args,input){const child=spawn(exe,args,{windowsHide:true,env:{SystemRoot:'C:/Windows',WINDIR:'C:/Windows'},stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',b=>{output+=b;if(output.length>16384)child.kill();});child.stderr.resume();child.stdin.on('error',()=>{});const timer=setTimeout(()=>child.kill(),6000);try{
  const code=await new Promise(done=>{child.once('error',()=>done(-1));child.once('close',done);child.stdin.end(input?JSON.stringify(input)+'\n':'');});return {code,events:output.trim().split('\n').map(line=>JSON.parse(line))};
}finally{clearTimeout(timer);}}
try{
  const product=join(bundle,'OwnerBootstrap.exe'),codec=join(bundle,'OwnerActivationCodec.exe');
  for(const [out,extra]of [[product,[]],[codec,['/main:OwnerActivationCodecMain',fixture]]])await promisify(execFile)('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',['/nologo','/target:exe','/platform:x64','/r:System.Web.Extensions.dll','/out:'+out,source,...extra],{windowsHide:true,timeout:30000,env:{SystemRoot:'C:/Windows',WINDIR:'C:/Windows'}});
  report.productSha256=hash(await readFile(product));const own=await run(product,['facts']);assert.equal(own.code,0);report.ordinaryIdentity=own.events[0].facts;
  const policy={domain:'owner.activation.v1',instanceId:'inst_'+'a'.repeat(32),controlSid:'S-1-5-80-1-2-3-4-5',ownerSid:report.ordinaryIdentity.sid,ownerSessionId:report.ordinaryIdentity.sessionId};
  const frame={version:1,operation:'owner.activation.request',instanceId:policy.instanceId,requestId:'a'.repeat(32),expiresAtUnixMs:Date.now()+25000,challenge:'a'.repeat(43),launchNonce:'b'.repeat(64)};
  async function check(name,patch,expected){const result=await run(codec,[],{policy,frame,phase:'request',...patch}),event=result.events.at(-1);assert.equal(result.code,expected?1:0,name);assert.equal(event.kind,expected?'error':'accepted',name);if(expected)assert.equal(event.code,expected,name);report.checks.push({name,scope:'native codec; synthetic policy/frame',pass:true});}
  await check('request',{});await check('challenge',{phase:'challenge',frame:{...frame,operation:'owner.activation.challenge',launchNonce:undefined}});
  for(const phase of ['ready','receipt','committed'])await check(phase,{phase,frame:{...frame,operation:'owner.activation.'+phase},original:frame});
  for(const [name,patch,expected]of [
    ['CLI domain',{frame:{...frame,operation:'owner.cli'}},'OBC_OPERATION_DENIED'],
    ['browser domain',{frame:{...frame,operation:'owner.browser'}},'OBC_OPERATION_DENIED'],
    ['cookie field',{frame:{...frame,sessionToken:'a'.repeat(64)}},'OBC_ACTIVATION_FRAME_INVALID'],
    ['ticket field',{frame:{...frame,bootstrapTicket:'a'.repeat(64)}},'OBC_ACTIVATION_FRAME_INVALID'],
    ['downgrade',{frame:{...frame,version:2}},'OBC_OPERATION_DENIED'],
    ['string deadline',{frame:{...frame,expiresAtUnixMs:String(frame.expiresAtUnixMs)}},'OBC_BINDING_MISMATCH'],
    ['expiry',{frame:{...frame,expiresAtUnixMs:Date.now()-1}},'OBC_EXPIRED'],
    ['extended original deadline',{original:{...frame,expiresAtUnixMs:frame.expiresAtUnixMs-1}},'OBC_BINDING_MISMATCH'],
    ['nonce mismatch',{original:{...frame,launchNonce:'c'.repeat(64)}},'OBC_LAUNCH_NONCE_MISMATCH'],
    ['newline nonce',{frame:{...frame,launchNonce:frame.launchNonce+'\n'}},'OBC_LAUNCH_NONCE_INVALID'],
    ['different instance',{frame:{...frame,instanceId:'inst_'+'b'.repeat(32)}},'OBC_BINDING_MISMATCH'],
  ])await check(name,patch,expected);
  const self={sid:policy.controlSid,sessionId:0};await check('private server policy',{phase:'policy',server:true,self});await check('boot listener needs no active Owner session',{phase:'policy',server:true,self,policy:{...policy,ownerSessionId:0}});
  await check('client cannot use listener session wildcard',{phase:'policy',server:false,self:{sid:policy.ownerSid,sessionId:1},policy:{...policy,ownerSessionId:0}},'OBC_ACTIVATION_POLICY_INVALID');
  await check('policy cannot choose pipe',{phase:'policy',server:true,self,policy:{...policy,pipeName:'evil'}},'OBC_ACTIVATION_POLICY_INVALID');
  await check('policy domain',{phase:'policy',server:true,self,policy:{...policy,domain:'owner.cli'}},'OBC_ACTIVATION_POLICY_INVALID');
  for(const [name,mode,input,expected]of [
    ['actual ordinary process is not control','activation-server',policy,'OBC_LOCAL_IDENTITY_DENIED'],
    ['actual client wrong Owner','activation-client',{...policy,ownerSid:'S-1-5-21-1-2-3-999'},'OBC_LOCAL_IDENTITY_DENIED'],
    ['actual client extra credential','activation-client',{...policy,sessionToken:'a'.repeat(64)},'OBC_ACTIVATION_POLICY_INVALID'],
    ['activation policy cannot use CLI mode','client',policy,'OBC_POLICY_INVALID'],
    ['ordinary caller cannot requery as control','peer-facts',{pid:123,createdTicks:'134368500000000000',ownerSid:policy.ownerSid,ownerSessionId:policy.ownerSessionId,controlSid:policy.controlSid},'OBC_LOCAL_IDENTITY_DENIED'],
    ['peer requery rejects extra authority','peer-facts',{pid:123,createdTicks:'134368500000000000',ownerSid:policy.ownerSid,ownerSessionId:policy.ownerSessionId,controlSid:policy.controlSid,sessionToken:'a'.repeat(64)},'OBC_POLICY_INVALID'],
    ['peer requery rejects session zero','peer-facts',{pid:123,createdTicks:'134368500000000000',ownerSid:policy.ownerSid,ownerSessionId:0,controlSid:policy.controlSid},'OBC_POLICY_INVALID'],
  ]){const result=await run(product,[mode],input);assert.equal(result.code,1,name);assert.equal(result.events.at(-1).code,expected,name);report.checks.push({name,scope:'actual ordinary Windows process',pass:true});}
  assert.equal(hash(await readFile(source)),report.sourceSha256);assert.equal(hash(await readFile(fixture)),report.fixtureSha256);report.pass=true;
}catch(error){report.error={code:error.code||error.name,message:String(error.message).replace(/[a-f0-9]{64}/g,'[redacted]')};process.exitCode=1;}
finally{await writeFile(join(bundle,'report.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({pass:report.pass,checks:report.checks.length,bundle,...report.error?{error:report.error}:{}}));
