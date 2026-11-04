import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';
import { TextDecoder } from 'node:util';

// GLOBALROOT addresses the system object-manager namespace instead of a
// caller-supplied SystemRoot environment variable. The fixed PowerShell query
// then asks Windows for the machine-wide known folder, not a user-selected
// ProgramData path. A failure never falls back to an environment override.
const SYSTEM_ROOT_LINK = String.raw`\\?\GLOBALROOT\SystemRoot`;
// No PowerShell cmdlets: even a seemingly harmless cmdlet could autoload a
// caller-controlled module before the trust inspector has run.
const QUERY = "$u=[Text.Encoding]::UTF8; foreach($f in @([Environment+SpecialFolder]::Windows,[Environment+SpecialFolder]::CommonApplicationData,[Environment+SpecialFolder]::ProgramFiles,[Environment+SpecialFolder]::ProgramFilesX86)){if($f -eq [Environment+SpecialFolder]::ProgramFilesX86 -and -not [Environment]::Is64BitOperatingSystem){$f=[Environment+SpecialFolder]::ProgramFiles};$p=[Environment]::GetFolderPath($f,[Environment+SpecialFolderOption]::DoNotVerify);if($f -eq [Environment+SpecialFolder]::ProgramFilesX86 -and !$p){[Console]::WriteLine('-')}else{[Console]::WriteLine([Convert]::ToBase64String($u.GetBytes($p)))}}";
const absoluteLocal = value => typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value) &&
  !/[\x00-\x1f<>\"|?*]/.test(value) && !value.slice(2).includes(':') &&
  value.slice(3).split(/[\\/]/).every(part => part !== '.' && part !== '..' && !/[. ]$/.test(part));
const decodeLine = value => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('invalid encoded OS path');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('noncanonical encoded OS path');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
};

export function resolveOwnerWindowsOsPaths({ platform = process.platform, realpath = realpathSync.native, run = spawnSync } = {}) {
  // These constants keep pure protocol tests portable; production Windows
  // always uses the OS-backed path query below.
  if (platform !== 'win32') return Object.freeze({ windows: 'C:\\Windows', programData: 'C:\\ProgramData', programFiles: 'C:\\Program Files', programFilesX86: 'C:\\Program Files (x86)', powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' });
  try {
    const raw = realpath(SYSTEM_ROOT_LINK);
    if (!absoluteLocal(raw)) return null;
    const windows = win32.normalize(raw);
    if (windows === win32.parse(windows).root) return null;
    const powershell = win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const encoded = Buffer.from(QUERY, 'utf16le').toString('base64');
    const result = run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true, timeout: 10000, maxBuffer: 8192, encoding: 'utf8',
      env: { SystemRoot: windows, WINDIR: windows },
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 8192) return null;
    const lines = result.stdout.replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
    if (lines.length !== 4) return null;
    const [observedWindows, observedData, observedFiles] = lines.slice(0, 3).map(decodeLine);
    const observedFilesX86 = lines[3] === '-' ? '' : decodeLine(lines[3]);
    if (!absoluteLocal(observedWindows) || !absoluteLocal(observedData) || !absoluteLocal(observedFiles) || (observedFilesX86 && !absoluteLocal(observedFilesX86)) ||
        win32.normalize(observedWindows).toLowerCase() !== windows.toLowerCase()) return null;
    const programData = win32.normalize(observedData);
    const programFiles = win32.normalize(observedFiles);
    const programFilesX86 = observedFilesX86 ? win32.normalize(observedFilesX86) : '';
    if ([programData, programFiles, programFilesX86].some(value => value && value === win32.parse(value).root)) return null;
    return Object.freeze({ windows, programData, programFiles, programFilesX86, powershell });
  } catch { return null; }
}

const installedPaths = resolveOwnerWindowsOsPaths();
export function ownerWindowsOsPaths() { return installedPaths; }
