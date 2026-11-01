// Independent interpretation of downloaded disposable-runner evidence. A valid
// failure record is verificationPass=true, never lifecycle acceptance PASS.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(process.argv[2]||''),runId=process.argv[3];
assert.match(runId||'',/^\d+$/);assert.ok(process.argv[2]);
const bytes=await readFile(join(root,'report.json')),r=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
assert.equal(r.actualMsi,true);assert.equal(r.productionHostTouched,false);assert.equal(r.runId,runId);
assert.equal(r.artifacts.preview.hash,'6ae728a6f397024742bea2e0590b9a8fa25650fbdb4c2de49f50249b1f9807a2');
assert.equal(r.artifacts.previous.hash,'ad7384d40f2923d5deebc95f0c0923a41f8806d0820f93ad394b4305f85aeda0');
assert.ok(Date.parse(r.completedAt)>=Date.parse(r.startedAt));assert.ok(Array.isArray(r.operations)&&r.operations.length>0);assert.ok(Array.isArray(r.probes));assert.ok(Array.isArray(r.failures));
const hashes={};for(const name of await readdir(root)){if(/^[a-z0-9.-]+\.(?:log|json)$/.test(name))hashes[name]=createHash('sha256').update(await readFile(join(root,name))).digest('hex');}
for(const o of r.operations){assert.ok(['preview','previous'].includes(o.artifact));assert.ok(['/i','/fa','/x'].includes(o.operation));assert.ok(Number.isInteger(o.exitCode));assert.equal(o.pass,o.exitCode===0||(o.absentAllowed&&o.exitCode===1605));assert.ok(hashes[o.stage+'.msi.log'],o.stage);}
const stage=name=>r.probes.find(p=>p.stage===name),operation=name=>r.operations.find(o=>o.stage===name);
if(r.pass){
 assert.deepEqual(r.failures,[]);assert.equal(r.cleanupConfirmed,true);
 for(const name of ['fresh-install','repair','fresh-uninstall','previous-install','upgrade'])assert.equal(operation(name)?.exitCode,0,name);
 for(const name of ['fresh','restart','repair','previous','upgraded']){const p=stage(name);assert.equal(p?.pass,true,name);assert.equal(p.health.status,200);assert.equal(p.htmlStatus,200);assert.equal(p.automaticOwner,true);assert.equal(p.services.length,2);assert.ok(p.services.every(s=>s.State==='Running'));}
 assert.equal(stage('upgrade-state')?.sentinelPreserved,true);assert.equal(stage('upgrade-state')?.secretPreserved,true);
 for(const name of ['fresh-removed','final-removed']){const p=stage(name);assert.equal(p?.pass,true);assert.equal(p.servicesRemaining,0);assert.deepEqual(p.processesRemaining,[]);assert.equal(p.serviceHostPresent,false);}
}else assert.ok(r.failures.length>0);
const verified={verificationPass:true,acceptancePass:r.pass,runId,startedAt:r.startedAt,completedAt:r.completedAt,previewSha256:r.artifacts.preview.hash,operations:r.operations,probes:r.probes,failures:r.failures,cleanupConfirmed:r.cleanupConfirmed,productionHostTouched:false,hashes};
await writeFile(join(root,'verified.json'),JSON.stringify(verified,null,2)+'\n');
console.log(JSON.stringify({verificationPass:true,acceptancePass:r.pass,runId,failures:r.failures,cleanupConfirmed:r.cleanupConfirmed,operations:r.operations.map(o=>[o.stage,o.exitCode])}));
