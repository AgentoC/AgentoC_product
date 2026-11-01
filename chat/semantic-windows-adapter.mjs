/**
 * Fixed-argv Windows package adapters.
 *
 * Builders only derive invocations from a signed semantic capability. They do
 * not execute anything. Execution remains disabled until a Windows executor
 * provides peer identity, service, ACL, and package revalidation primitives.
 */

export const SEMANTIC_ADAPTER_WINGET_INSTALL_V1 = 'windows-winget-install/v1';
export const SEMANTIC_ADAPTER_MSI_INSTALL_V1 = 'windows-msi-install/v1';
// The executable is server-owned configuration (fixed-argv invariant: never a
// requester-provided executable). Defaults are the canonical system paths; a
// deployment where winget/msiexec live elsewhere (e.g. WindowsApps only, or a
// non-standard install) overrides via env without touching the invocation
// grammar.
//
// Security (adversarial acceptance I-3/I-4): the override is read only from
// the trusted process environment (systemd EnvironmentFile on the privileged
// executor; the transport's allowlisted spawn env), never from a request
// payload or CLI argument — the adapters never accept an executable from the
// caller. The value must be an absolute drive-rooted Windows path; a relative,
// UNC, or syntactically invalid override fails closed at import (service will
// not start with a bad deployment value). Existence + executability are
// enforced at the point of use: revalidation and dispatch execFile the path,
// and a missing/non-executable binary fails closed.
export const WINGET_EXECUTABLE = resolveConfiguredExecutable(
  'AGENTOC_WINGET_EXECUTABLE',
  'C:\\Windows\\System32\\winget.exe',
);
export const MSIEXEC_EXECUTABLE = resolveConfiguredExecutable(
  'AGENTOC_MSIEXEC_EXECUTABLE',
  'C:\\Windows\\System32\\msiexec.exe',
);

function resolveConfiguredExecutable(envKey, defaultPath) {
  const candidate = trimString(process.env?.[envKey]) || defaultPath;
  if (!/^[A-Za-z]:\\[^:*?"<>|]+$/i.test(candidate)) {
    throw new Error(`${envKey} must be an absolute Windows executable path`);
  }
  return candidate;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fail(error) {
  const result = new Error(error);
  result.code = 'SEMANTIC_WINDOWS_ADAPTER_DENIED';
  throw result;
}

function safePackageId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimString(value));
}

function safeVersion(value) {
  return !value || /^[A-Za-z0-9][A-Za-z0-9._+:-]*$/.test(trimString(value));
}

function wingetField(output, label) {
  const match = String(output || '').match(new RegExp(`^${label}\\s*:\\s*(.+?)\\s*$`, 'im'));
  return trimString(match?.[1]);
}

function validateOperation(entry, adapter, predicate) {
  if (!entry || entry.platform !== 'win32' || entry.primaryAction !== 'package.install'
    || entry.executionClass !== 'host'
    || JSON.stringify([...(entry.effects || [])].map(trimString).sort()) !== JSON.stringify(['process.execute'])
    || !predicate(entry.adapterInput || {})) {
    fail(`Operation is not supported by ${adapter}`);
  }
}

export function buildWindowsWingetInstallInvocation(capability = {}) {
  if (trimString(capability.adapter) !== SEMANTIC_ADAPTER_WINGET_INSTALL_V1) fail('Unsupported Windows adapter');
  const operations = Array.isArray(capability.operations) ? capability.operations : [];
  // winget's install grammar is single-id. Do not concatenate multiple
  // owner selections into an ambiguous argv; a future batch adapter can issue
  // one independently revalidated invocation per package.
  if (operations.length !== 1) fail('winget adapter accepts exactly one package');
  const inputs = operations.map((entry) => {
    validateOperation(entry, SEMANTIC_ADAPTER_WINGET_INSTALL_V1, (input) => (
      input.manager === 'winget'
      && input.source === 'winget'
      && input.exact === true
      && Array.isArray(input.packages)
      && input.packages.length === 1
      && input.packages.every(safePackageId)
      && Array.isArray(input.requestedVersions)
      && input.requestedVersions.length === 1
      && input.requestedVersions.every(safeVersion)
      && Array.isArray(input.resolvedVersions)
      && input.resolvedVersions.length === 1
      && input.resolvedVersions.every((value) => trimString(value) && safeVersion(value))
      && input.sourceTrust === 'configured'
    ));
    return entry.adapterInput;
  });
  const argv = ['install'];
  for (const input of inputs) {
    argv.push('--id', input.packages[0], '--exact', '--source', 'winget');
    if (input.resolvedVersions[0]) argv.push('--version', input.resolvedVersions[0]);
  }
  argv.push('--accept-source-agreements', '--accept-package-agreements');
  return { executable: WINGET_EXECUTABLE, argv, cwd: 'C:\\' };
}

export function buildWindowsMsiInstallInvocation(capability = {}) {
  if (trimString(capability.adapter) !== SEMANTIC_ADAPTER_MSI_INSTALL_V1) fail('Unsupported Windows adapter');
  const operations = Array.isArray(capability.operations) ? capability.operations : [];
  if (operations.length !== 1) fail('MSI adapter accepts exactly one artifact');
  const entry = operations[0];
  validateOperation(entry, SEMANTIC_ADAPTER_MSI_INSTALL_V1, (input) => (
    input.manager === 'msiexec'
    && input.source === 'local_artifact'
    && typeof input.artifactPath === 'string'
    && /^([A-Za-z]):\\[^:*?"<>|]+$/i.test(input.artifactPath)
    && /^[0-9a-f]{64}$/.test(trimString(input.artifactDigest))
  ));
  return {
    executable: MSIEXEC_EXECUTABLE,
    argv: ['/i', entry.adapterInput.artifactPath, '/qn', '/norestart'],
    cwd: 'C:\\',
  };
}

export async function revalidateWindowsWingetInstall(capability, { execFile } = {}) {
  if (typeof execFile !== 'function') return { ok: false, code: 'WINDOWS_REVALIDATION_REQUIRED', error: 'winget metadata revalidation provider is required' };
  let invocation;
  try { invocation = buildWindowsWingetInstallInvocation(capability); } catch (error) {
    return { ok: false, code: error.code, error: error.message };
  }
  for (const entry of capability.operations) {
    const input = entry.adapterInput;
    try {
      const result = await execFile(WINGET_EXECUTABLE, ['show', '--id', input.packages[0], '--exact', '--source', 'winget'], { cwd: 'C:\\', windowsHide: true });
      const output = String(result?.stdout || '');
      if (wingetField(output, 'Id') !== input.packages[0]
        || wingetField(output, 'Version') !== input.resolvedVersions[0]
        || wingetField(output, 'Source').toLowerCase() !== 'winget') {
        return { ok: false, code: 'WINDOWS_REVALIDATION_FAILED', error: `winget metadata changed for ${input.packages[0]}` };
      }
    } catch (error) {
      return { ok: false, code: 'WINDOWS_REVALIDATION_FAILED', error: error?.message || String(error) };
    }
  }
  return { ok: true, invocation };
}

export async function revalidateWindowsMsiInstall(capability, { artifactFacts } = {}) {
  if (typeof artifactFacts !== 'function') return { ok: false, code: 'WINDOWS_REVALIDATION_REQUIRED', error: 'MSI artifact revalidation provider is required' };
  let invocation;
  try { invocation = buildWindowsMsiInstallInvocation(capability); } catch (error) {
    return { ok: false, code: error.code, error: error.message };
  }
  const input = capability.operations[0].adapterInput;
  const current = await artifactFacts(input.artifactPath).catch(() => null);
  if (!current || trimString(current.identity) !== trimString(input.artifactIdentity)
    || trimString(current.digest).toLowerCase() !== trimString(input.artifactDigest).toLowerCase()) {
    return { ok: false, code: 'WINDOWS_REVALIDATION_FAILED', error: 'MSI artifact identity or digest changed' };
  }
  return { ok: true, invocation };
}
