#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  buildSemanticAptInstallInvocation,
  revalidateSemanticAptInstall,
} from '../scripts/privileged-executor.mjs';
import { SEMANTIC_ADAPTER_APT_INSTALL_V1 } from '../chat/semantic-capability.mjs';

let passed = 0;
function eq(label, actual, expected) {
  assert.deepEqual(actual, expected, `failed: ${label}`);
  passed += 1;
}
function throwsCode(label, fn, code) {
  assert.throws(fn, (error) => error?.code === code, `failed: ${label}`);
  passed += 1;
}

const capability = {
  adapter: SEMANTIC_ADAPTER_APT_INSTALL_V1,
  operations: [
    { primaryAction: 'package.install', platform: 'linux', executionClass: 'host', effects: ['process.execute'], adapterInput: { manager: 'apt-get', source: 'trusted_repository', packages: ['nginx'], requestedVersions: [''], resolvedVersions: ['1.0'], repositories: [{ id: 'debian-bookworm-main', trust: 'configured' }] } },
    { primaryAction: 'package.install', platform: 'linux', executionClass: 'host', effects: ['process.execute'], adapterInput: { manager: 'apt-get', source: 'trusted_repository', packages: ['curl'], requestedVersions: [''], resolvedVersions: ['1.0'], repositories: [{ id: 'debian-bookworm-main', trust: 'configured' }] } },
  ],
};

const invocation = buildSemanticAptInstallInvocation(capability);
eq('adapter fixes executable path', invocation.executable, '/usr/bin/apt-get');
eq('adapter derives argv only from signed operation inputs', invocation.argv, ['install', 'nginx', 'curl']);
eq('adapter fixes cwd', invocation.cwd, '/');
throwsCode('shell adapter is unavailable', () => buildSemanticAptInstallInvocation({ ...capability, adapter: 'shell/v1' }), 'SEMANTIC_CAPABILITY_ADAPTER_DENIED');
throwsCode('option cannot enter fixed argv', () => buildSemanticAptInstallInvocation({
  ...capability,
  operations: [{ adapterInput: { manager: 'apt-get', packages: ['--allow-unauthenticated'] } }],
}), 'SEMANTIC_CAPABILITY_ADAPTER_DENIED');
throwsCode('path cannot enter fixed argv', () => buildSemanticAptInstallInvocation({
  ...capability,
  operations: [{ adapterInput: { manager: 'apt-get', packages: ['/tmp/evil.deb'] } }],
}), 'SEMANTIC_CAPABILITY_ADAPTER_DENIED');
throwsCode('session operation cannot enter host adapter', () => buildSemanticAptInstallInvocation({
  ...capability,
  operations: [{ ...capability.operations[0], executionClass: 'session' }],
}), 'SEMANTIC_CAPABILITY_ADAPTER_DENIED');
throwsCode('privilege effect cannot enter host adapter', () => buildSemanticAptInstallInvocation({
  ...capability,
  operations: [{ ...capability.operations[0], effects: ['privilege.elevate', 'process.execute'] }],
}), 'SEMANTIC_CAPABILITY_ADAPTER_DENIED');

const calls = [];
const valid = await revalidateSemanticAptInstall(capability, {
  execFile: async (executable, argv, options) => {
    calls.push({ executable, argv, options });
    return { stdout: `Package: ${argv.at(-1)}\nVersion: 1.0\ndebian-bookworm-main\n` };
  },
});
eq('fresh package metadata revalidates', valid.ok, true);
eq('revalidation checks every selected package', calls.map((call) => call.argv.at(-1)), ['nginx', 'curl']);
eq('revalidation uses fixed apt-cache executable', calls.every((call) => call.executable === '/usr/bin/apt-cache'), true);
eq('revalidation uses no caller environment', calls.every((call) => call.options.env.PATH === '/usr/sbin:/usr/bin:/sbin:/bin'), true);

const stale = await revalidateSemanticAptInstall(capability, {
  execFile: async () => ({ stdout: '' }),
});
eq('missing package metadata fails closed', stale.code, 'SEMANTIC_CAPABILITY_REVALIDATION_FAILED');
const failed = await revalidateSemanticAptInstall(capability, {
  execFile: async () => { throw new Error('apt lists unavailable'); },
});
eq('metadata probe error fails closed', failed.code, 'SEMANTIC_CAPABILITY_REVALIDATION_FAILED');

const changedVersion = await revalidateSemanticAptInstall({
  ...capability,
  operations: [{
    ...capability.operations[0],
    adapterInput: { ...capability.operations[0].adapterInput, requestedVersions: ['2.0'] },
  }],
}, {
  execFile: async () => ({ stdout: 'Package: nginx\nVersion: 1.0\ndebian-bookworm-main\n' }),
});
eq('requested version change fails closed', changedVersion.code, 'SEMANTIC_CAPABILITY_REVALIDATION_FAILED');

const changedCandidate = await revalidateSemanticAptInstall({
  ...capability,
  operations: [{
    ...capability.operations[0],
    adapterInput: { ...capability.operations[0].adapterInput, resolvedVersions: ['2.0'] },
  }],
}, {
  execFile: async () => ({ stdout: 'Package: nginx\nVersion: 1.0\ndebian-bookworm-main\n' }),
});
eq('resolved candidate change fails closed', changedCandidate.code, 'SEMANTIC_CAPABILITY_REVALIDATION_FAILED');

const changedRepository = await revalidateSemanticAptInstall({
  ...capability,
  operations: [{
    ...capability.operations[0],
    adapterInput: { ...capability.operations[0].adapterInput, repositories: [{ id: 'evil-repository', trust: 'configured' }] },
  }],
}, {
  execFile: async () => ({ stdout: 'Package: nginx\nVersion: 1.0\ndebian-bookworm-main\n' }),
});
eq('repository change fails closed', changedRepository.code, 'SEMANTIC_CAPABILITY_REVALIDATION_FAILED');

console.log(`semantic-executor-adapter: ${passed} checks passed`);
