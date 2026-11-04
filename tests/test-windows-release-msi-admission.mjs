// Actual ordinary host refusal; never executes msiexec or creates services.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,access,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {resolveWindowsSystemPaths} from '../chat/windows-system-paths.mjs';
assert.equal(process.platform,'win32');
const exec=promisify(execFile),ps=resolveWindowsSystemPaths()?.powershell,root=await mkdtemp(join(tmpdir(),'agct-msi-admission-'));
assert.ok(ps,'Windows system PowerShell must be discoverable');
const source=resolve('scripts/qa-windows-release-msi.ps1'),evidence=join(root,'must-not-create'),args=['-NoProfile','-NonInteractive','-File',source,'-ArtifactDirectory',join(root,'missing-input'),'-EvidenceDirectory',evidence];
const rows=[];
for(const env of [{...process.env,GITHUB_ACTIONS:'false'},{...process.env,GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'self-hosted'},{...process.env,GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'owner/private-qa-repository',RUNNER_OS:'Windows',GITHUB_REF:'refs/heads/main'}]){
 let result;try{await exec(ps,args,{windowsHide:true,timeout:15000,env});assert.fail('Host execution admitted');}catch(error){result={code:error.code,stdout:error.stdout||'',stderr:error.stderr||''};}
 assert.equal(result.code,1);assert.match(result.stderr,/MSIQ_DISPOSABLE_RUNNER_REQUIRED/);await assert.rejects(access(evidence),{code:'ENOENT'});rows.push(result);
}
await exec(ps,['-NoProfile','-NonInteractive','-Command',`$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${source.replaceAll("'","''")}',[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors|Out-String)};$calls=@($ast.EndBlock.Statements);$gate=@($calls|Where-Object {$_.Extent.Text -ceq 'Assert-QaDisposable'});if($gate.Count -ne 1){throw 'Exactly one first gate required'};$mutate=@($calls|Where-Object {$_.Extent.Text -match '^New-Item '});if($mutate.Count -ne 1 -or $mutate[0].Extent.StartOffset -lt $gate[0].Extent.EndOffset){throw 'Mutation before admission'};'AST_AND_ADMISSION_PASS'`],{windowsHide:true,timeout:15000});
await writeFile(join(root,'report.json'),JSON.stringify({pass:true,hostRefusals:rows.length,ordinaryHostMutation:false,rows},null,2));console.log(JSON.stringify({pass:true,hostRefusals:3,ast:true,root}));
