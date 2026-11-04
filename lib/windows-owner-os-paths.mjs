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
const QUERY = "$u=[Text.Encoding]::UTF8; foreach($f in @([Environment+SpecialFolder]::Windows,[Environment+SpecialFolder]::CommonApplicationData,[Environment+SpecialFolder]::ProgramFiles)){[Console]::WriteLine([Convert]::ToBase64String($u.GetBytes([Environment]::GetFolderPath($f))))}";
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
  if (platform !== 'win32') return Object.freeze({ windows: 'C:\\Windows', programData: 'C:\\ProgramData', programFiles: 'C:\\Program Files', powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' });
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
    if (lines.length !== 3) return null;
    const [observedWindows, observedData, observedFiles] = lines.map(decodeLine);
    if (!absoluteLocal(observedWindows) || !absoluteLocal(observedData) || !absoluteLocal(observedFiles) ||
        win32.normalize(observedWindows).toLowerCase() !== windows.toLowerCase()) return null;
    const programData = win32.normalize(observedData);
    const programFiles = win32.normalize(observedFiles);
    if (programData === win32.parse(programData).root || programFiles === win32.parse(programFiles).root) return null;
    return Object.freeze({ windows, programData, programFiles, powershell });
  } catch { return null; }
}

const installedPaths = resolveOwnerWindowsOsPaths();
export function ownerWindowsOsPaths() { return installedPaths; }
