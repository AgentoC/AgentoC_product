import assert from 'node:assert/strict';
import { resolveWindowsPerUserPaths } from '../lib/windows-runtime-paths.mjs';
import { harnessInstallationStatePath } from '../lib/harness-paths.mjs';
import { join } from 'node:path';

const root = 'C:\\ProgramData\\AgentoC\\instances\\owner';
const env = {
  LOCALAPPDATA: 'C:\\ProgramData\\AgentoC\\instances\\owner\\home\\AppData\\Local',
  AGENTOC_RUNNER_LAUNCH_MODE: 'runner-supervisor',
  AGENTOC_RUN_SPOOL_DIR: `${root}\\data\\chat-runs`,
  AGENTOC_PROVIDER_HOMES_DIR: `${root}\\provider-homes\\by-provider\\${'a'.repeat(32)}`,
};
const paths = resolveWindowsPerUserPaths({ platform: 'win32', env });
assert.equal(paths.instanceRoot, root);
assert.equal(paths.spoolDir, env.AGENTOC_RUN_SPOOL_DIR);
assert.equal(paths.providerHomesDir, env.AGENTOC_PROVIDER_HOMES_DIR);
assert.throws(() => resolveWindowsPerUserPaths({ platform: 'win32', env: { ...env, AGENTOC_RUNNER_LAUNCH_MODE: '' } }), { code: 'WINDOWS_RUNTIME_PATH_INVALID' });
assert.throws(() => resolveWindowsPerUserPaths({ platform: 'win32', env: { ...env, AGENTOC_PROVIDER_HOMES_DIR: 'C:\\ProgramData\\another\\provider-homes' } }), { code: 'WINDOWS_RUNTIME_PATH_INVALID' });
assert.throws(() => resolveWindowsPerUserPaths({ platform: 'win32', env: { ...env, AGENTOC_CONFIG_DIR: `${root}\\config` } }), { code: 'WINDOWS_RUNTIME_PATH_INVALID' });
assert.equal(harnessInstallationStatePath('config', { platform: 'win32', env, harnessRoot: 'harness' }), join('harness', 'harness-installations.json'));
assert.equal(harnessInstallationStatePath('config', { platform: 'win32', env: {}, harnessRoot: 'harness' }), join('config', 'harness-installations.json'));
console.log('Windows supervised runner paths: ok');
