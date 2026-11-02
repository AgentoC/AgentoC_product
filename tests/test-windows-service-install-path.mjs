import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const powershell = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
for (const [root, prefix] of [
  ['G:\\AgentoCapp', 'G:\\AgentoCapp\\AgentoC.ServiceHost.exe --role '],
  ['G:\\Program Files\\AgentoC', '"G:\\Program Files\\AgentoC\\AgentoC.ServiceHost.exe" --role '],
]) {
  const script = "$env:AGENTOC_INSTALL_ROOT='" + root + "'; . ./packaging/windows/prepare-owner-services.ps1 -LibraryOnly; Get-OwnerServicePreparationPlan | ConvertTo-Json -Compress";
  const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30000 });
  const rows = JSON.parse(stdout);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.ok(row.command.startsWith(prefix), row.command);
}
console.log('PASS: service registration matches Windows Installer for paths with and without spaces');
