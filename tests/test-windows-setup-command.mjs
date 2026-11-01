#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  buildWindowsSetupServiceProbePowerShell,
  resolveWindowsServiceSetupPaths,
  runWindowsSetupCommand,
} from '../lib/windows-setup-command.mjs';

const env = {
  ProgramData: 'C:\\ProgramData',
  AGENTOC_POWERSHELL: 'powershell-fixture.exe',
};

assert.deepEqual(resolveWindowsServiceSetupPaths({ platform: 'win32', env }), {
  dataRoot: 'C:\\ProgramData\\AgentoC',
  instanceRoot: 'C:\\ProgramData\\AgentoC\\instances\\owner',
  configDir: 'C:\\ProgramData\\AgentoC\\instances\\owner\\config',
  runtimeDir: 'C:\\ProgramData\\AgentoC\\instances\\owner\\runtime',
  authFile: 'C:\\ProgramData\\AgentoC\\instances\\owner\\config\\auth.json',
});
assert.throws(
  () => resolveWindowsServiceSetupPaths({ platform: 'win32', env: { ProgramData: '\\\\server\\share' } }),
  (error) => error.code === 'WINDOWS_SETUP_PROGRAM_DATA_INVALID',
);
assert.throws(
  () => resolveWindowsServiceSetupPaths({ platform: 'linux', env }),
  (error) => error.code === 'WINDOWS_SETUP_PLATFORM_REQUIRED',
);

const probe = buildWindowsSetupServiceProbePowerShell();
assert.match(probe, /Get-Service -Name/);
assert.match(probe, /AgentoC-RunnerSupervisor/);
assert.match(probe, /AgentoC-ControlPlane/);
assert.match(probe, /ConvertTo-Json/);
assert.doesNotMatch(probe, /bash|systemctl/);

const calls = [];
const output = [];
const result = await runWindowsSetupCommand([], {
  platform: 'win32',
  env,
  powershellPath: 'powershell-fixture.exe',
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  sourceRoot: 'C:\\Program Files\\AgentoC\\current\\payload',
  execFileImpl: async (command, args, options) => {
    calls.push({ type: 'probe', command, args, options });
    return {
      stdout: JSON.stringify({
        installed: true,
        missing: [],
        states: {
          'AgentoC-RunnerSupervisor': 'Running',
          'AgentoC-ControlPlane': 'Running',
        },
      }),
    };
  },
  spawnFileImpl: async (command, args, options) => {
    calls.push({ type: 'password', command, args, options });
  },
  lifecycleImpl: async (options) => {
    calls.push({ type: 'lifecycle', options });
  },
  fetchImpl: async (url, options) => {
    calls.push({ type: 'health', url, options });
    return { ok: true, status: 200 };
  },
  writer: (value) => output.push(value),
});

assert.equal(result, 0);
assert.deepEqual(calls.map((call) => call.type), ['probe', 'password', 'lifecycle', 'health']);
assert.deepEqual(calls[1].args, ['C:\\Program Files\\AgentoC\\current\\payload\\set-password.mjs']);
assert.equal(calls[1].options.env.AGENTOC_WINDOWS_SERVICE_MODE, '1');
assert.equal(calls[1].options.env.AGENTOC_CONFIG_DIR, 'C:\\ProgramData\\AgentoC\\instances\\owner\\config');
assert.equal(calls[2].options.action, 'restart');
assert.equal(calls[2].options.service, 'all');
assert.match(output.join(''), /Windows setup complete/);
assert.match(output.join(''), /127\.0\.0\.1:7690/);

await assert.rejects(
  runWindowsSetupCommand(['--check-only'], {
    platform: 'win32',
    env,
    execFileImpl: async () => ({ stdout: JSON.stringify({ installed: false, missing: ['AgentoC-ControlPlane'] }) }),
    writer: () => {},
  }),
  (error) => error.code === 'WINDOWS_SETUP_MSI_REQUIRED',
);

const checkOutput = [];
assert.equal(await runWindowsSetupCommand(['--check-only'], {
  platform: 'win32',
  env,
  execFileImpl: async () => ({ stdout: JSON.stringify({ installed: true, missing: [], states: {} }) }),
  writer: (value) => checkOutput.push(value),
}), 0);
assert.match(checkOutput.join(''), /services installed/);

console.log('test-windows-setup-command: ok');
