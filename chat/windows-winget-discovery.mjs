import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFileDefault = promisify(execFileCallback);
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$nativeProgramFiles = ''
try {
  $key = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64).OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion')
  if ($key) { try { $nativeProgramFiles = [string]$key.GetValue('ProgramFilesDir', '') } finally { $key.Dispose() } }
} catch { }
$packages = @(Get-AppxPackage -Name Microsoft.DesktopAppInstaller -ErrorAction SilentlyContinue)
if ($packages.Count -eq 0) {
  try { $packages = @(Get-AppxPackage -AllUsers -Name Microsoft.DesktopAppInstaller -ErrorAction Stop) } catch { $packages = @() }
}
$packages = @($packages | Where-Object {
  $_.PackageFamilyName -ceq 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe' -and
  $_.InstallLocation -and $_.Status -eq 'Ok'
} | Sort-Object Version -Descending)
foreach ($package in $packages) {
  $exe = Join-Path $package.InstallLocation 'winget.exe'
  try {
    $item = Get-Item -LiteralPath $exe -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
    $signature = Get-AuthenticodeSignature -LiteralPath $exe -ErrorAction Stop
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '^CN=Microsoft Corporation(?:,|$)') { continue }
    @{ executable = $item.FullName; family = $package.PackageFamilyName; signature = 'Valid'; programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles); nativeProgramFiles = $nativeProgramFiles } | ConvertTo-Json -Compress
    exit 0
  } catch { continue }
}
throw 'Verified Windows Package Manager is unavailable'
`;

/** Server-owned discovery; no path or script content is taken from a request. */
export async function discoverWindowsWinget({ execFile = execFileDefault, platform = process.platform, timeoutMs = 15000,
  systemRoot = process.env.SystemRoot || process.env.WINDIR,
  programFiles = process.env.ProgramW6432 || process.env.ProgramFiles } = {}) {
  if (platform !== 'win32') throw new Error('Windows Package Manager discovery requires Windows');
  const win = path.win32;
  if (!systemRoot || !win.isAbsolute(systemRoot) || !/^[a-z]:\\/i.test(systemRoot)) throw new Error('Windows system root is unavailable');
  const root = win.resolve(systemRoot);
  const system32 = win.join(root, 'System32');
  const powershell = win.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const env = { SystemRoot: root, WINDIR: root, PATH: `${system32};${root}` };
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
  const result = await execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], {
    cwd: system32, env, shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024,
  });
  let facts;
  try { facts = JSON.parse(String(result.stdout || '').trim()); } catch { throw new Error('Windows Package Manager discovery returned invalid facts'); }
  const executable = typeof facts?.executable === 'string' ? path.win32.normalize(facts.executable) : '';
  const packageDir = win.dirname(executable);
  const appsDir = win.dirname(packageDir);
  const packageName = win.basename(packageDir);
  const roots = [];
  if (programFiles && win.isAbsolute(programFiles) && /^[a-z]:\\/i.test(programFiles)) roots.push(win.resolve(programFiles, 'WindowsApps'));
  // Detached runs deliberately omit ProgramFiles from their environment. The
  // trusted discovery probe obtains the OS known folder independently, so a
  // normal WindowsApps install still works without a caller-provided hint.
  if (typeof facts?.programFiles === 'string' && /^[a-z]:\\/i.test(facts.programFiles) && win.isAbsolute(facts.programFiles)) roots.push(win.resolve(facts.programFiles, 'WindowsApps'));
  if (typeof facts?.nativeProgramFiles === 'string' && /^[a-z]:\\/i.test(facts.nativeProgramFiles) && win.isAbsolute(facts.nativeProgramFiles)) roots.push(win.resolve(facts.nativeProgramFiles, 'WindowsApps'));
  if (/^[a-z]:\\/i.test(executable)) roots.push(win.join(win.parse(executable).root, 'WindowsApps'));
  if (facts?.family !== 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe' || facts?.signature !== 'Valid'
      || win.basename(executable).toLowerCase() !== 'winget.exe'
      || !/^Microsoft\.DesktopAppInstaller_[0-9]+(?:\.[0-9]+){3}_(?:x64|x86|arm64)__8wekyb3d8bbwe$/i.test(packageName)
      || !roots.some((candidate) => candidate.toLowerCase() === appsDir.toLowerCase())) {
    throw new Error('Windows Package Manager identity is unverified');
  }
  return executable;
}
