import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,realpath,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
assert.equal(process.platform,'win32','Actual NTFS test: run only on Windows.');
const exec=promisify(execFile),root=await mkdtemp(join(await realpath(tmpdir()),'agct-opi-'));
await writeFile(join(root,'qa-instance.json'),JSON.stringify({testOnly:true,purpose:'owner-install-policy',pid:process.pid}));
const powershell='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
try{
  const {stdout}=await exec(powershell,['-NoProfile','-NonInteractive','-File','tests/windows-owner-install-policy-native.ps1','-EvidenceRoot',root],{windowsHide:true,timeout:25000,maxBuffer:1024*1024,env:{SystemRoot:'C:/Windows',WINDIR:'C:/Windows'}});
  const report=JSON.parse(stdout.replace(/^\uFEFF/,''));assert.equal(report.pass,true);assert.equal(report.checks.length,30);assert.ok(report.checks.every(c=>c.pass));
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await writeFile(join(root,'failure.json'),JSON.stringify({pass:false,exitCode:error.code,stdout:error.stdout||'',stderr:error.stderr||'',message:error.message},null,2));console.error('NATIVE_POLICY_FAIL '+root);throw error;}
