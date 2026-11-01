import { spawn } from 'node:child_process';

/**
 * Native Windows lifecycle control for the installed ServiceHost runtime.
 *
 * The MSI owns two services. Keep the service names and ordering here so the
 * Node CLI never has to invoke a POSIX shell on Windows.
 */

export const WINDOWS_SERVICE_CONTROL_VERSION = 'windows-service-control/v1';

const SERVICE_ORDER = Object.freeze({
  start: Object.freeze(['AgentoC-RunnerSupervisor', 'AgentoC-ControlPlane']),
  stop: Object.freeze(['AgentoC-ControlPlane', 'AgentoC-RunnerSupervisor']),
});

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function serviceError(message, code = 'WINDOWS_SERVICE_CONTROL_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function resolveWindowsServiceNames(service = 'all') {
  const normalized = (trimString(service) || 'all').toLowerCase();
  if (normalized === 'all' || normalized === 'chat' || normalized === 'control-plane') {
    return normalized === 'control-plane'
      ? Object.freeze(['AgentoC-ControlPlane'])
      : Object.freeze([...SERVICE_ORDER.start]);
  }
  if (normalized === 'control') return Object.freeze(['AgentoC-ControlPlane']);
  if (normalized === 'supervisor' || normalized === 'runner-supervisor') {
    return Object.freeze(['AgentoC-RunnerSupervisor']);
  }
  if (normalized === 'tunnel' || normalized === 'bridge' || normalized === 'provider') {
    throw serviceError(
      `Windows does not install a ${normalized} service; use the MSI-managed Control Plane and Runner Supervisor services.`,
      'WINDOWS_SERVICE_NOT_AVAILABLE',
    );
  }
  throw serviceError(
    `Unknown Windows service '${service}'. Use all, chat, control, or supervisor.`,
    'WINDOWS_SERVICE_UNKNOWN',
  );
}

function buildServiceArray(names) {
  return names.map(quotePowerShell).join(', ');
}

function buildWaitLoop() {
  return [
    `$deadline = (Get-Date).ToUniversalTime().AddSeconds(30)`,
    `do {`,
    `  $service.Refresh()`,
    `  if ($service.Status.ToString() -eq $status) { break }`,
    `  if ((Get-Date).ToUniversalTime() -ge $deadline) { throw "Timed out while waiting for Windows service to $actionName." }`,
    `  Start-Sleep -Milliseconds 250`,
    `} while ($true)`,
  ];
}

/**
 * Build a fixed-argv PowerShell script. Service names come only from the
 * allowlist above; caller input is never interpolated as executable syntax.
 */
export function buildWindowsServicePowerShell(action, service = 'all') {
  const normalizedAction = trimString(action).toLowerCase();
  if (!['start', 'stop', 'restart'].includes(normalizedAction)) {
    throw serviceError(`Unknown Windows service action '${action}'.`);
  }

  const names = resolveWindowsServiceNames(service);
  const orderedNames = normalizedAction === 'stop'
    ? [...names].sort((left, right) => SERVICE_ORDER.stop.indexOf(left) - SERVICE_ORDER.stop.indexOf(right))
    : [...names].sort((left, right) => SERVICE_ORDER.start.indexOf(left) - SERVICE_ORDER.start.indexOf(right));
  const operationNames = normalizedAction === 'restart'
    ? [...orderedNames].sort((left, right) => SERVICE_ORDER.stop.indexOf(left) - SERVICE_ORDER.stop.indexOf(right))
    : orderedNames;
  const startNames = [...orderedNames].sort((left, right) => SERVICE_ORDER.start.indexOf(left) - SERVICE_ORDER.start.indexOf(right));
  const stopNames = [...orderedNames].sort((left, right) => SERVICE_ORDER.stop.indexOf(left) - SERVICE_ORDER.stop.indexOf(right));
  const actionPastTense = {
    start: 'started',
    stop: 'stopped',
    restart: 'restarted',
  }[normalizedAction];

  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `$startNames = @(${buildServiceArray(startNames)})`,
    `$stopNames = @(${buildServiceArray(stopNames)})`,
    'function Get-AgentoCService([string]$name) {',
    '  $service = Get-Service -Name $name -ErrorAction SilentlyContinue',
    '  if (-not $service) { throw "AgentoC Windows service is not installed: $name. Install the AgentoC MSI first." }',
    '  return $service',
    '}',
    'function Wait-AgentoCService([object]$service, [string]$status, [string]$actionName) {',
    ...buildWaitLoop(),
    '}',
  ];

  if (normalizedAction === 'stop' || normalizedAction === 'restart') {
    lines.push(
      'foreach ($name in $stopNames) {',
      '  $service = Get-Service -Name $name -ErrorAction SilentlyContinue',
      '  if ($service -and $service.Status.ToString() -ne \'Stopped\') {',
      '    Stop-Service -Name $name -Force -ErrorAction Stop',
      '    Wait-AgentoCService $service \'Stopped\' \'stop\'',
      '  }',
      '}',
    );
  }
  if (normalizedAction === 'start' || normalizedAction === 'restart') {
    lines.push(
      'foreach ($name in $startNames) {',
      '  $service = Get-AgentoCService $name',
      '  if ($service.Status.ToString() -ne \'Running\') {',
      '    Start-Service -Name $name -ErrorAction Stop',
      '    Wait-AgentoCService $service \'Running\' \'start\'',
      '  }',
      '}',
    );
  }
  lines.push(`Write-Output ${quotePowerShell(`AgentoC Windows services ${actionPastTense}: ${operationNames.join(', ')}`)}`);
  return lines.join('\n');
}

function defaultSpawnFile(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(signal
        ? `${command} exited with signal ${signal}`
        : `${command} exited with code ${code}`);
      error.status = code ?? 1;
      reject(error);
    });
  });
}

export async function runWindowsServiceLifecycle({
  action,
  service = 'all',
  platform = process.platform,
  powershellPath = process.env.AGENTOC_POWERSHELL || 'powershell.exe',
  spawnFileImpl = defaultSpawnFile,
} = {}) {
  if (platform !== 'win32') {
    throw serviceError('Windows service lifecycle requires win32.', 'WINDOWS_SERVICE_PLATFORM_REQUIRED');
  }
  const command = trimString(powershellPath);
  if (!command) throw serviceError('A PowerShell executable is required.');
  const script = buildWindowsServicePowerShell(action, service);
  await spawnFileImpl(command, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ]);
}
