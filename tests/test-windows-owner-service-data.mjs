// Real PowerShell ACL construction and installed-host refusal; no SCM writes.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
assert.equal(process.platform,'win32');
const exec=promisify(execFile),ps='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',file=resolve('packaging/windows/prepare-owner-service-data.ps1');
const control='S-1-5-80-1-2-3-4-5',executor='S-1-5-80-6-7-8-9-10',owner='S-1-5-21-1-2-3-1001';
const command=`. '${file.replaceAll("'","''")}' -LibraryOnly; Initialize-OwnerDataDirectoryType; @(Get-OwnerDataLayout '${control}' '${executor}' '${owner}'|ForEach-Object {$a=New-OwnerDataAcl $_.grants $_.traverseOnly;@{path=$_.relative;owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=$a.AreAccessRulesProtected;rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object {@{sid=$_.IdentityReference.Value;mask=[int64]$_.FileSystemRights;inheritance=[int]$_.InheritanceFlags}})}})|ConvertTo-Json -Depth 5 -Compress`;
const rows=JSON.parse((await exec(ps,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:60000,maxBuffer:65536})).stdout);
assert.equal(rows.length,19);assert.equal(new Set(rows.map(r=>r.path)).size,19);
const get=path=>{const row=rows.find(r=>r.path===path);assert.ok(row);return row;},rule=(path,sid)=>get(path).rules.find(r=>r.sid===sid);
for(const row of rows){assert.equal(row.owner,'S-1-5-32-544');assert.equal(row.protected,true);assert.ok(!row.path.split('\\').includes('..'));assert.ok(row.rules.every(r=>['S-1-5-18','S-1-5-32-544',control,executor,owner].includes(r.sid)));}
assert.equal(rule('instances\\owner\\config',executor),undefined);assert.ok(rule('instances\\owner\\config',control).mask&2);
assert.equal(rule('instances\\owner\\executor\\config',control),undefined);assert.ok(rule('instances\\owner\\executor\\config',executor).mask&2);
assert.equal(rule('instances\\owner\\runtime',executor),undefined);assert.ok(rule('instances\\owner\\runtime',owner).mask&1);assert.equal(rule('instances\\owner\\runtime',owner).mask&2,0);
assert.ok(rule('harnesses',control).mask&2);assert.equal(rule('harnesses',executor).mask&2,0);
for(const path of ['instances\\owner\\workspace','instances\\owner\\provider-homes','instances\\owner\\data\\chat-runs']){assert.ok(rule(path,control).mask&2);assert.ok(rule(path,executor).mask&2);}
assert.equal(rule('',control).inheritance,0);assert.equal(rule('',executor).inheritance,0);
const metadataOwnerPaths=new Set(['','instances','instances\\owner']);
for(const path of metadataOwnerPaths){
 const ownerRule=rule(path,owner);assert.ok(ownerRule,'Owner must be able to inspect each fixed metadata ancestor');
 assert.equal(ownerRule.inheritance,0,'Owner metadata access must not flow to descendants');
 assert.equal(ownerRule.mask&0x000d0156,0,'Owner metadata access must not grant write, delete, or ACL changes');
 assert.ok(ownerRule.mask&1);assert.ok(ownerRule.mask&128);assert.ok(ownerRule.mask&131072);
}
for(const path of ['instances\\owner\\executor','instances\\owner\\data'])assert.equal(rule(path,owner),undefined,'Owner must not enumerate executor or data roots');
for(const extra of [[],['-Commit']]){
 let result;try{await exec(ps,['-NoLogo','-NoProfile','-NonInteractive','-File',file,...extra],{windowsHide:true,timeout:60000,maxBuffer:65536});assert.fail('Legacy installed services adopted');}catch(e){assert.equal(e.code,1);result=JSON.parse(e.stdout);}
 assert.equal(result.code,'ODP_DISABLED_PREPARED_SERVICES_REQUIRED');assert.equal(result.lockRetained,false);assert.equal(result.servicesActivated,false);
}
console.log(JSON.stringify({pass:true,directoryProfiles:19,defaultAndCommitInstalledRefusal:true,nativeFactoryCompiled:true,servicesCreated:false,authorityIssued:false}));
