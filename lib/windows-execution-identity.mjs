import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repairMessage = 'Ordinary Windows tasks require a non-elevated user runtime. Repair the execution identity; do not run tasks through the SYSTEM service.';

// This fixed probe inherits the caller's token, as does the ordinary Node
// child launch. No identity claim comes from a request, manifest or environment
// flag. SID and mandatory-label values are independent of the Windows language.
const identityProbe = String.raw`
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$groups = & "$env:SystemRoot\System32\whoami.exe" /groups /fo csv /nh
if ($LASTEXITCODE -ne 0) { throw "Token groups unavailable (exit $LASTEXITCODE)" }
$labels = @([regex]::Matches(($groups -join [Environment]::NewLine), 'S-1-16-\d+') | ForEach-Object { $_.Value } | Select-Object -Unique)
if ($labels.Count -ne 1) { throw 'Mandatory token label unavailable' }
[pscustomobject]@{
  version = 1
  sid = $identity.User.Value
  isSystem = $identity.IsSystem
  isService = @($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-6' }).Count -gt 0
  isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  integrityRid = [int]($labels[0].Split('-')[-1])
} | ConvertTo-Json -Compress
`;

function identityError(code) {
  return Object.assign(new Error(`${code}: ${repairMessage}`), { code });
}

export async function readWindowsExecutionIdentity({ execFileImpl = execFileAsync, env = process.env } = {}) {
  try {
    const configuredRoot = typeof env.SystemRoot === 'string' && env.SystemRoot.trim() ? env.SystemRoot.trim() : typeof env.WINDIR === 'string' ? env.WINDIR.trim() : '';
    if (typeof configuredRoot !== 'string' || !/^[A-Za-z]:[\\/]/.test(configuredRoot)) throw new Error('Windows root unavailable');
    const windowsRoot = win32.normalize(configuredRoot);
    const powershell = win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await execFileImpl(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(identityProbe, 'utf16le').toString('base64'),
    ], {
      windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024,
      // The runner deliberately strips most OS environment keys. PowerShell
      // needs the Windows directory and executable extensions for native
      // invocation; supply them only here, without widening the Run allowlist.
      env: { ...env, SystemRoot: windowsRoot, WINDIR: windowsRoot, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    });
    const identity = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    if (identity?.version !== 1 || !/^S-1-\d+(?:-\d+)+$/.test(identity.sid)
        || typeof identity.isSystem !== 'boolean' || typeof identity.isService !== 'boolean' || typeof identity.isAdministrator !== 'boolean'
        || !Number.isInteger(identity.integrityRid) || identity.integrityRid < 0) {
      throw new Error('Invalid token evidence');
    }
    return identity;
  } catch {
    // Probe diagnostics may include local identifiers. Keep only a typed error.
    throw identityError('WINDOWS_EXECUTION_IDENTITY_UNAVAILABLE');
  }
}

export async function assertOrdinaryWindowsExecutionIdentity({
  platform = process.platform,
  readIdentityImpl = readWindowsExecutionIdentity,
} = {}) {
  if (platform !== 'win32') return null;
  const identity = await readIdentityImpl();
  if (identity?.version !== 1 || !/^S-1-\d+(?:-\d+)+$/.test(identity.sid)
      || typeof identity.isSystem !== 'boolean' || typeof identity.isService !== 'boolean' || typeof identity.isAdministrator !== 'boolean'
      || !Number.isInteger(identity.integrityRid) || identity.integrityRid < 0) {
    throw identityError('WINDOWS_EXECUTION_IDENTITY_UNAVAILABLE');
  }
  // Service accounts and High/System integrity cannot launch ordinary tasks.
  // There is deliberately no elevated-task opt-out: privileged operations use
  // the separate approved-action executor, never this ordinary Run channel.
  if (identity.isSystem || ['S-1-5-18', 'S-1-5-19', 'S-1-5-20'].includes(identity.sid)
      || identity.isAdministrator || identity.integrityRid >= 12288) {
    throw identityError('WINDOWS_EXECUTION_IDENTITY_UNSAFE');
  }
  return identity;
}
