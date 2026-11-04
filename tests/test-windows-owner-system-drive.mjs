import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ownerWindowsOsPaths } from '../lib/windows-owner-os-paths.mjs';

test('a restricted Windows PowerShell environment resolves the machine ProgramData folder', { skip: process.platform !== 'win32' }, () => {
  const paths = ownerWindowsOsPaths();
  assert.ok(paths);
  // Match the MSI bridge's actual ProcessStartInfo environment construction.
  // Do not read a drive from caller-supplied environment variables.
  const script = `$w=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows);` +
    `$p=[Diagnostics.ProcessStartInfo]::new();$p.FileName=[IO.Path]::Combine($w,'System32','WindowsPowerShell','v1.0','powershell.exe');` +
    `$p.Arguments='-NoLogo -NoProfile -NonInteractive -Command "[Console]::Write([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData))"';` +
    `$p.UseShellExecute=$false;$p.RedirectStandardOutput=$true;$p.CreateNoWindow=$true;$p.EnvironmentVariables.Clear();` +
    `$p.EnvironmentVariables['SystemRoot']=$w;$p.EnvironmentVariables['WINDIR']=$w;$p.EnvironmentVariables['SystemDrive']=[IO.Path]::GetPathRoot($w).TrimEnd('\\');` +
    `$c=[Diagnostics.Process]::Start($p);$out=$c.StandardOutput.ReadToEnd();$c.WaitForExit();if($c.ExitCode -ne 0){exit 1};[Console]::Write($out)`;
  const result = spawnSync(paths.powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().toLowerCase(), paths.programData.toLowerCase());
});
