import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { analyzeWindowsFileChanges, analyzeWindowsPowerShell, decideWindowsPowerShellActions } from '../chat/windows-powershell-actions.mjs';
import { decideWindowsApproval } from '../chat/windows-approval-gate.mjs';
import { resolveWindowsSystemPaths } from '../chat/windows-system-paths.mjs';

if (process.platform !== 'win32') {
  console.log('windows-powershell-actions: skipped (requires Windows)');
  process.exit(0);
}
const root = await mkdtemp(path.join(os.tmpdir(), 'agentoc-powershell-actions-'));
const workspace = path.join(root, 'workspace');
await mkdir(path.join(workspace, 'folder'), { recursive: true });
await mkdir(path.join(workspace, 'linked-dest'), { recursive: true });
await mkdir(path.join(workspace, 'existing-dest', 'folder', '.ssh'), { recursive: true });
await mkdir(path.join(workspace, 'sensitive-folder', '.ssh'), { recursive: true });
await mkdir(path.join(workspace, 'build', 'nested'), { recursive: true });
await mkdir(path.join(workspace, 'build-sensitive', '.ssh'), { recursive: true });
await writeFile(path.join(workspace, 'readme.txt'), 'fixture');
await writeFile(path.join(root, 'ordinary.txt'), 'outside fixture');
await mkdir(path.join(root, 'outside-folder'));
await mkdir(path.join(root, 'profile', 'AppData', 'Roaming', 'Microsoft', 'Credentials'), { recursive: true });
await mkdir(path.join(root, 'profile', 'AppData', 'Local', 'Microsoft', 'Protect'), { recursive: true });
await mkdir(path.join(root, 'profile', 'AppData', 'Local', 'ordinary-app'), { recursive: true });
await writeFile(path.join(root, 'profile', 'NTUSER.DAT'), 'fixture');
await writeFile(path.join(workspace, 'sensitive-folder', '.ssh', 'fixture-key'), 'fixture');
await writeFile(path.join(workspace, 'build', 'nested', 'output.txt'), 'fixture');
await writeFile(path.join(workspace, 'build-sensitive', '.ssh', 'fixture-key'), 'fixture');
await link(path.join(workspace, 'sensitive-folder', '.ssh', 'fixture-key'), path.join(workspace, 'ordinary-link'));
await link(path.join(workspace, 'sensitive-folder', '.ssh', 'fixture-key'), path.join(workspace, 'linked-dest', 'readme.txt'));
const context = { cwd: workspace, trustedWorkspaceRoot: workspace, protectedRoots: [path.join(root, 'protected')] };
async function inspect(command, options) {
  const result = await analyzeWindowsPowerShell(command, context, options);
  return { ...result, ...decideWindowsPowerShellActions(result) };
}
for (const target of [path.join(root, 'profile', 'NTUSER.DAT'), path.join(root, 'profile', 'AppData', 'Roaming', 'Microsoft', 'Credentials', 'fixture'),
  path.join(root, 'profile', 'AppData', 'Local', 'Microsoft', 'Protect', 'fixture')]) {
  for (const kind of ['read', 'write', 'delete']) {
    assert.equal(decideWindowsPowerShellActions(await analyzeWindowsFileChanges([{ path: target, kind }], context)).decision, 'review', `${kind}: protected profile path`);
  }
}
assert.equal(decideWindowsPowerShellActions(await analyzeWindowsFileChanges([{ path: path.join(root, 'profile', 'AppData', 'Local', 'ordinary-app', 'fixture'), kind: 'write' }], context)).decision, 'allow');
{
  const previous = process.env.ProgramData;
  const shared = path.join(root, 'relocated-shared-data');
  await mkdir(shared);
  try {
    process.env.ProgramData = shared;
    const script = `Set-Content -LiteralPath '${path.join(shared, 'fixture.txt').replace(/'/g, "''")}' -Value hello`;
    for (const riskMode of ['recommended', 'full-auto']) {
      const approval = { kind: 'command', params: { command: [resolveWindowsSystemPaths().powershell, '-NoProfile', '-Command', script] } };
      assert.equal((await decideWindowsApproval(approval, { riskMode, cwd: workspace, riskContext: context })).decision, 'prompt', `${riskMode}: relocated ProgramData`);
    }
  } finally {
    if (previous === undefined) delete process.env.ProgramData; else process.env.ProgramData = previous;
  }
}
let result = await inspect('Get-Content readme.txt | Select-Object -First 1');
assert.equal(result.decision, 'allow');
assert.equal(result.actions.length, 2);
assert.equal((await inspect('Get-Process -Name explorer | Select-Object -First 1')).decision, 'allow');
assert.equal((await inspect('Get-Command -Name Get-Content -CommandType Cmdlet')).decision, 'allow');
assert.equal((await inspect('Get-Process -Id $env:PID')).decision, 'review');
assert.equal((await inspect('Get-Command -Name Get-Content; Remove-Item . -Recurse')).decision, 'review');
result = await inspect('Set-Content -Path result.txt -Value hello');
assert.equal(result.decision, 'allow');
assert.equal(result.actions[0].kind, 'write');
assert.equal((await inspect('mkdir new-folder')).decision, 'allow');
assert.equal((await inspect('mkdir -Path ..\\outside-new -Force')).decision, 'allow');
assert.equal((await inspect('mkdir -Path ..\\protected\\new-folder')).decision, 'review');
assert.equal((await inspect('mkdir -Path $env:TEMP')).decision, 'review');
assert.equal((await inspect('mkdir folder other-folder')).decision, 'review');
assert.equal((await inspect('Get-ChildItem folder | mkdir -Path new-folder')).decision, 'review');
assert.equal((await inspect('mkdir -Name new-folder')).decision, 'review');
assert.equal((await inspect('Write-Output hello > result.txt')).decision, 'allow');
assert.equal((await inspect('Write-Output hello >> result.txt')).decision, 'allow');
assert.equal((await inspect('Write-Output hello > ..\\protected\\result.txt')).decision, 'review');
assert.equal((await inspect('Write-Output hello > ordinary-link')).decision, 'review');
assert.equal((await inspect('Write-Output hello > $env:TEMP')).decision, 'review');
assert.equal((await inspect('Write-Output hello 2>&1')).decision, 'review');
assert.equal((await inspect("'hello' > result.txt")).decision, 'allow');
assert.equal((await inspect("'hello' >> result.txt")).decision, 'allow');
assert.equal((await inspect("'hello' > ..\\protected\\result.txt")).decision, 'review');
assert.equal((await inspect("'hello' > ordinary-link")).decision, 'review');
assert.equal((await inspect("'hello' > $env:TEMP")).decision, 'review');
assert.equal((await inspect("(Get-Date).Date > result.txt")).decision, 'review');
assert.equal((await inspect("'hello' | Out-File -FilePath result.txt -Encoding utf8")).decision, 'allow');
assert.equal((await inspect('Write-Output hello | Out-File -Append result.txt')).decision, 'allow');
assert.equal((await inspect('Write-Output hello | Out-File -LiteralPath ..\\protected\\result.txt')).decision, 'review');
assert.equal((await inspect('Write-Output hello | Out-File -FilePath ordinary-link')).decision, 'review');
assert.equal((await inspect('Write-Output hello | Out-File -FilePath result.txt -LiteralPath other.txt')).decision, 'review');
assert.equal((await inspect('Write-Output hello | Out-File -FilePath $env:TEMP')).decision, 'review');
assert.equal((await inspect('Set-Content -LiteralPath .env:stream -Value hello')).decision, 'review');
assert.equal((await inspect('Write-Output hello > NUL')).decision, 'review');
assert.equal((await inspect('Write-Output hello > CON.txt')).decision, 'review');
assert.equal((await inspect("Write-Output hello > '.env.'")).decision, 'review');
assert.equal((await inspect('Get-Content ordinary-link')).decision, 'review');
assert.equal((await inspect('Set-Content ordinary-link -Value hello')).decision, 'review');
assert.equal((await inspect('Remove-Item ordinary-link')).decision, 'allow');
assert.equal((await inspect('Remove-Item readme.txt -Recurse')).decision, 'review');
assert.equal(decideWindowsPowerShellActions(await analyzeWindowsFileChanges([{ path: path.join(workspace, 'ordinary-link'), kind: 'write' }], context)).decision, 'review');
result = await inspect('Copy-Item -Path readme.txt -Destination result.txt');
assert.equal(result.decision, 'allow');
assert.deepEqual(result.actions.map((a) => a.kind), ['read', 'write']);
assert.equal((await inspect('Copy-Item -Path readme.txt -Destination linked-dest')).decision, 'review');
assert.equal((await inspect('Move-Item -Path readme.txt -Destination linked-dest')).decision, 'review');
for (const riskMode of ['recommended', 'full-auto']) {
  const approval = (script) => ({ kind: 'command', params: { command: [resolveWindowsSystemPaths().powershell, '-NoProfile', '-Command', script] } });
  const state = { riskMode, cwd: workspace, riskContext: context };
  assert.equal((await decideWindowsApproval(approval('Copy-Item readme.txt -Destination linked-dest'), state)).decision, 'prompt');
  assert.equal((await decideWindowsApproval(approval('Copy-Item readme.txt -Destination ordinary-output.txt'), state)).decision, 'auto-allow');
  for (const script of [
    'Get-Content -LiteralPath ..\\ordinary.txt',
    'Set-Content -LiteralPath ..\\outside-output.txt -Value hello',
    'Remove-Item -LiteralPath ..\\ordinary.txt',
  ]) {
    assert.equal((await decideWindowsApproval(approval(script), state)).decision, 'auto-allow', `${riskMode}: ${script}`);
  }
  assert.equal((await decideWindowsApproval(approval('Set-Content -LiteralPath ..\\protected\\result.txt -Value hello'), state)).decision, 'prompt');
  assert.equal((await decideWindowsApproval(approval('Remove-Item -LiteralPath ..\\outside-folder -Recurse'), state)).decision, 'prompt');
}
assert.equal((await inspect('Get-ChildItem -Path folder -Recurse')).decision, 'allow');
assert.equal((await inspect("Get-ChildItem -Path folder -Filter '*.md'")).decision, 'allow');
assert.equal((await inspect("Get-ChildItem -Path folder -Filter '*.md' -Recurse")).decision, 'allow');
assert.equal((await inspect('Get-ChildItem -Path folder -File -Name')).decision, 'allow');
assert.equal((await inspect('Get-ChildItem -Path folder -Depth 1 -Directory')).decision, 'allow');
assert.equal((await inspect('Get-ChildItem -Path sensitive-folder -Depth 1 -File')).decision, 'review');
assert.equal((await inspect('Get-ChildItem -Path folder -Depth $env:depth')).decision, 'review');
assert.equal((await inspect("Get-ChildItem -Path sensitive-folder -Filter '*.md' -Recurse")).decision, 'review');
assert.equal((await inspect("Remove-Item -Path folder -Filter '*.md' -Recurse")).decision, 'review');
assert.equal((await inspect('Get-ChildItem -Path folder -Filter $env:filter')).decision, 'review');
assert.equal((await inspect('Get-ChildItem -Path ..\\outside-folder -Recurse')).decision, 'allow');
assert.equal((await inspect('Get-ChildItem -Path sensitive-folder -Recurse')).decision, 'review');
assert.equal((await inspect('Copy-Item -Path folder -Destination copied -Recurse')).decision, 'allow');
assert.equal((await inspect('Copy-Item -Path sensitive-folder -Destination copied -Recurse')).decision, 'review');
assert.equal((await inspect('Copy-Item -Path folder -Destination sensitive-folder -Recurse')).decision, 'allow');
assert.equal((await inspect('Copy-Item -Path folder -Destination existing-dest -Recurse')).decision, 'review');
result = await inspect('Move-Item -Path readme.txt -Destination result.txt');
assert.deepEqual(result.actions.map((a) => a.kind), ['delete', 'write']);
assert.equal(result.decision, 'allow');
result = await inspect('Remove-Item -LiteralPath folder -Recurse');
assert.equal(result.decision, 'review');
const wildcardDeletion = await analyzeWindowsPowerShell('Remove-Item -Path build\\* -Recurse -Force', context);
// Simulate a new sensitive entry arriving after inspection but before the
// approval decision; the original wildcard would expand again at execution.
await mkdir(path.join(workspace, 'build', '.ssh'));
await writeFile(path.join(workspace, 'build', '.ssh', 'late-key'), 'fixture');
assert.equal(decideWindowsPowerShellActions(wildcardDeletion).decision, 'review');
assert.equal(decideWindowsPowerShellActions(wildcardDeletion, { conservative: true }).decision, 'review');
assert.ok(wildcardDeletion.actions.every(action => action.requiresPinnedExecution));
assert.equal((await inspect('Remove-Item -Path build-sensitive\\* -Recurse -Force')).decision, 'review');
assert.equal((await inspect('Remove-Item -Path * -Recurse -Force')).decision, 'review');
assert.equal((await inspect('Remove-Item -Path ..\\outside-folder\\* -Recurse -Force')).decision, 'review');
assert.equal((await inspect('Remove-Item -Path build\\*.txt -Recurse -Force')).decision, 'review');
assert.equal((await inspect('Remove-Item -LiteralPath build\\* -Recurse -Force')).decision, 'review');
assert.equal((await inspect("Remove-Item -Path build\\* -Filter '*.txt' -Recurse")).decision, 'review');
result = await inspect('Remove-Item -LiteralPath .');
assert.equal(result.decision, 'review');
result = await inspect('Remove-Item -LiteralPath ..\\ordinary.txt');
assert.equal(result.decision, 'allow');
assert.equal(decideWindowsPowerShellActions(result, { conservative: true }).decision, 'review');
result = await inspect('Remove-Item -LiteralPath ..\\outside-folder');
assert.equal(result.decision, 'review');
result = await inspect('Move-Item -Path sensitive-folder -Destination moved');
assert.equal(result.decision, 'review');
result = await inspect('Set-Content -Path ..\\protected\\result.txt -Value hello');
assert.equal(result.decision, 'review');
result = await inspect('Get-Content $env:TEMP');
assert.equal(result.decision, 'review');
result = await inspect('ls . | Select-Object -First 1');
assert.equal(result.decision, 'allow');
assert.equal(result.actions[0].program, 'get-childitem');
result = await inspect('Get-Content readme.txt | Unknown-Command');
assert.equal(result.decision, 'review');
result = await inspect('New-Item -Path . -Name .env -ItemType File');
assert.equal(result.decision, 'review');
result = await inspect('New-Item -Path . -Name link -ItemType SymbolicLink -Value readme.txt');
assert.equal(result.decision, 'review');
assert.equal(decideWindowsPowerShellActions({ complete: true, actions: [{ kind: 'write', target: {}, workspace: false }] }, { conservative: true }).decision, 'review');
const rootDeletion = await analyzeWindowsFileChanges([{ path: workspace, kind: 'delete' }], context);
assert.equal(decideWindowsPowerShellActions(rootDeletion).decision, 'review');
const ordinaryDirectoryDeletion = await analyzeWindowsFileChanges([{ path: path.join(workspace, 'folder'), kind: 'delete' }], context);
await mkdir(path.join(workspace, 'folder', '.ssh'));
await writeFile(path.join(workspace, 'folder', '.ssh', 'late-key'), 'fixture');
assert.equal(decideWindowsPowerShellActions(ordinaryDirectoryDeletion).decision, 'review');
const outsideDirectoryRead = await analyzeWindowsFileChanges([{ path: path.join(root, 'outside-folder'), kind: 'read', recursive: true }], context);
assert.equal(decideWindowsPowerShellActions(outsideDirectoryRead).decision, 'allow');
const sensitiveDirectoryRead = await analyzeWindowsFileChanges([{ path: path.join(workspace, 'sensitive-folder'), kind: 'read', recursive: true }], context);
assert.equal(decideWindowsPowerShellActions(sensitiveDirectoryRead).decision, 'review');
const unknownChange = await analyzeWindowsFileChanges([{ path: path.join(workspace, 'readme.txt'), kind: 'unknown' }], context);
assert.equal(decideWindowsPowerShellActions(unknownChange).decision, 'review');
console.log('windows-powershell-actions: native AST and file policy checks passed');
