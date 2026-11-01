#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assessWindowsPathBoundary,
  deriveWindowsEndpointName,
  isWindowsPathWithin,
  normalizeWindowsInstanceName,
  resolveWindowsPerUserPaths,
  resolveWindowsServicePaths,
  windowsPathFacts,
} from '../lib/windows-runtime-paths.mjs';
import {
  acquireInstanceOwnership,
  INSTANCE_OWNERSHIP_ALREADY_ACTIVE,
  INSTANCE_OWNERSHIP_MISMATCH,
  readInstanceOwnership,
} from '../lib/instance-ownership.mjs';

const env = {
  LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local',
  AGENTOC_INSTANCE_NAME: 'owner workspace',
};
const perUserLauncher = await readFile(new URL('../scripts/windows-per-user-runtime.ps1', import.meta.url), 'utf8');
assert.match(
  perUserLauncher,
  /SetEnvironmentVariable\('AGENTOC_RUN_SPOOL_DIR', \$Paths\.spoolDir, 'Process'\)/,
  'per-user launcher must pass the validated spool root to the Supervisor process',
);
assert.match(
  perUserLauncher,
  /SetEnvironmentVariable\('AGENTOC_PROVIDER_HOMES_DIR', \$Paths\.providerHomesDir, 'Process'\)/,
  'per-user launcher must pass the validated provider-homes root to the Supervisor process',
);
const paths = resolveWindowsPerUserPaths({ platform: 'win32', env });
assert.match(paths.instanceRoot, /owner workspace$/);
assert.equal(paths.configDir, join(paths.instanceRoot, 'config').replaceAll('/', '\\'));
assert.equal(paths.spoolDir, join(paths.dataDir, 'chat-runs').replaceAll('/', '\\'));
assert.equal(paths.codexHomeDir, join(paths.providerHomesDir, 'codex').replaceAll('/', '\\'));
assert.equal(paths.claudeHomeDir, join(paths.providerHomesDir, 'claude').replaceAll('/', '\\'));
assert.equal(paths.workspaceDir, join(paths.instanceRoot, 'workspace').replaceAll('/', '\\'));
assert.equal(paths.platformSkillsDir, join(paths.instanceRoot, 'platform', 'skills').replaceAll('/', '\\'));
assert.equal(paths.instanceIdentityFile, join(paths.configDir, 'instance-identity.json').replaceAll('/', '\\'));
assert.equal(windowsPathFacts(paths).usesProgramData, false);
assert.equal(windowsPathFacts(paths).allUnderLocalAppData, true);
assert.equal(windowsPathFacts(paths).uniqueRoots, true);
assert.equal(isWindowsPathWithin(paths.productRoot, paths.providerHomesDir), true);
assert.equal(isWindowsPathWithin(paths.productRoot, '\\\\server\\share\\agentoc'), false);
assert.equal(isWindowsPathWithin(paths.instanceRoot, `${paths.instanceRoot}2`), false);
assert.equal(isWindowsPathWithin(paths.instanceRoot, `${paths.instanceRoot}\\..\\other`), false);

const runnerScopedEnv = {
  ...env,
  AGENTOC_RUN_SPOOL_DIR: `${paths.instanceRoot}\\data\\chat-runs`,
  AGENTOC_PROVIDER_HOMES_DIR: `${paths.instanceRoot}\\provider-homes`,
};
const runnerScopedPaths = resolveWindowsPerUserPaths({ platform: 'win32', env: runnerScopedEnv });
assert.equal(
  runnerScopedPaths.instanceRoot.toLowerCase(),
  paths.instanceRoot.toLowerCase(),
  'runner-scoped paths must recover their shared instance root when control-plane roots are stripped',
);
assert.equal(runnerScopedPaths.spoolDir, runnerScopedEnv.AGENTOC_RUN_SPOOL_DIR);
assert.equal(runnerScopedPaths.providerHomesDir, runnerScopedEnv.AGENTOC_PROVIDER_HOMES_DIR);

const customSpoolRunnerPaths = resolveWindowsPerUserPaths({
  platform: 'win32',
  env: {
    ...runnerScopedEnv,
    AGENTOC_RUN_SPOOL_DIR: `${paths.instanceRoot}\\data\\custom-spool`,
  },
});
assert.equal(customSpoolRunnerPaths.instanceRoot.toLowerCase(), paths.instanceRoot.toLowerCase());
assert.equal(customSpoolRunnerPaths.spoolDir, `${paths.instanceRoot}\\data\\custom-spool`);

assert.throws(
  () => resolveWindowsPerUserPaths({
    platform: 'win32',
    env: {
      ...runnerScopedEnv,
      AGENTOC_PROVIDER_HOMES_DIR: 'C:\\Users\\Alice\\AppData\\Local\\AgentoC\\instances\\other\\provider-homes',
    },
  }),
  (error) => error.code === 'WINDOWS_RUNTIME_PATH_INVALID',
  'runner-scoped paths from different instances must fail closed',
);

assert.equal(normalizeWindowsInstanceName('  财务\u0301  '), '财务́');
assert.equal(
  resolveWindowsPerUserPaths({
    platform: 'win32',
    env: { ...env, AGENTOC_INSTANCE_NAME: '财务\u0301' },
  }).instanceRoot,
  resolveWindowsPerUserPaths({
    platform: 'win32',
    env: { ...env, AGENTOC_INSTANCE_NAME: '财务́' },
  }).instanceRoot,
  'canonically equivalent instance names must share an instance root',
);

const cjkPaths = resolveWindowsPerUserPaths({
  platform: 'win32',
  env: { ...env, AGENTOC_INSTANCE_NAME: '财务 自动化' },
});
assert.match(cjkPaths.instanceRoot, /财务 自动化$/);
assert.equal(
  resolveWindowsPerUserPaths({ platform: 'win32', env: { ...env, AGENTOC_INSTANCE_NAME: 'OWNER WORKSPACE' } }).instanceRoot,
  paths.instanceRoot,
  'Windows case variants must map to the same durable instance root',
);

assert.throws(
  () => resolveWindowsPerUserPaths({ platform: 'linux', env }),
  (error) => error.code === 'WINDOWS_RUNTIME_PLATFORM_REQUIRED',
);
assert.throws(
  () => resolveWindowsPerUserPaths({ platform: 'win32', env: { ...env, AGENTOC_INSTANCE_NAME: '..\\escape' } }),
  (error) => error.code === 'WINDOWS_RUNTIME_PATH_INVALID',
);
assert.throws(
  () => resolveWindowsPerUserPaths({ platform: 'win32', env: { ...env, LOCALAPPDATA: '\\\\server\\share' } }),
  (error) => error.code === 'WINDOWS_RUNTIME_PATH_INVALID',
);
assert.throws(
  () => resolveWindowsPerUserPaths({ platform: 'win32', env: { ...env, LOCALAPPDATA: '\\temp' } }),
  (error) => error.code === 'WINDOWS_RUNTIME_PATH_INVALID',
);
assert.throws(
  () => resolveWindowsPerUserPaths({ platform: 'win32', env: { ...env, AGENTOC_INSTANCE_NAME: 'con' } }),
  (error) => error.code === 'WINDOWS_RUNTIME_PATH_INVALID',
);
for (const instanceName of ['CON.txt', 'com1', 'LPT9.log', 'COM¹', 'foo.']) {
  assert.throws(
    () => resolveWindowsPerUserPaths({ platform: 'win32', env: { ...env, AGENTOC_INSTANCE_NAME: instanceName } }),
    (error) => error.code === 'WINDOWS_RUNTIME_PATH_INVALID',
    `reserved or non-canonical instance name must fail closed: ${instanceName}`,
  );
}
for (const pathField of [
  'AGENTOC_INSTANCE_ROOT',
  'AGENTOC_CONFIG_DIR',
  'AGENTOC_RUN_SPOOL_DIR',
  'AGENTOC_PROVIDER_HOMES_DIR',
  'AGENTOC_WORK_ROOT_DIR',
  'AGENTOC_PLATFORM_SKILLS_DIR',
]) {
  assert.throws(
    () => resolveWindowsPerUserPaths({
      platform: 'win32',
      env: { ...env, [pathField]: '\\\\?\\C:\\Users\\Alice\\escape' },
    }),
    (error) => error.code === 'WINDOWS_RUNTIME_PATH_INVALID',
    `device path must be rejected for ${pathField}`,
  );
}
assert.throws(
  () => resolveWindowsPerUserPaths({
    platform: 'win32',
    env: { ...env, LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local\\..\\..\\..\\..\\ProgramData' },
  }),
  (error) => error.code === 'WINDOWS_RUNTIME_PATH_INVALID',
  'normalized ProgramData roots must not be used',
);
const servicePaths = resolveWindowsPerUserPaths({
  platform: 'win32',
  env: {
    ...env,
    AGENTOC_WINDOWS_SERVICE_MODE: '1',
    AGENTOC_INSTANCE_ROOT: 'C:\\ProgramData\\AgentoC\\instances\\owner',
    AGENTOC_CONFIG_DIR: 'C:\\ProgramData\\AgentoC\\instances\\owner\\config',
  },
});
assert.equal(servicePaths.instanceRoot, 'C:\\ProgramData\\AgentoC\\instances\\owner');
assert.equal(windowsPathFacts(servicePaths).usesProgramData, true);
const canonicalServicePaths = resolveWindowsServicePaths({
  platform: 'win32',
  env: {
    ProgramData: 'C:\\ProgramData',
    AGENTOC_INSTANCE_ROOT: 'C:\\Users\\Alice\\must-be-ignored',
    AGENTOC_RUN_SPOOL_DIR: 'C:\\Users\\Alice\\must-be-ignored\\data\\chat-runs',
  },
});
assert.equal(canonicalServicePaths.productRoot, 'C:\\ProgramData\\AgentoC');
assert.equal(canonicalServicePaths.instanceRoot, 'C:\\ProgramData\\AgentoC\\instances\\owner');
assert.equal(canonicalServicePaths.spoolDir, 'C:\\ProgramData\\AgentoC\\instances\\owner\\data\\chat-runs');
assert.equal(canonicalServicePaths.providerHomesDir, 'C:\\ProgramData\\AgentoC\\instances\\owner\\provider-homes');
assert.throws(
  () => resolveWindowsPerUserPaths({
    platform: 'win32',
    env: { ...env, AGENTOC_INSTANCE_ROOT: 'C:\\Users\\Alice\\instance', AGENTOC_CONFIG_DIR: 'C:\\Users\\Alice\\other\\config' },
  }),
  (error) => error.code === 'WINDOWS_RUNTIME_PATH_INVALID',
  'explicit config directory must remain inside explicit instance root',
);
assert.throws(
  () => resolveWindowsPerUserPaths({
    platform: 'win32',
    env: { ...env, AGENTOC_INSTANCE_ROOT: 'C:\\Users\\Alice\\instance', AGENTOC_CONFIG_DIR: 'C:\\Users\\Alice\\instance\\..\\other\\config' },
  }),
  (error) => error.code === 'WINDOWS_RUNTIME_PATH_INVALID',
  'normalized config traversal must remain inside explicit instance root',
);
assert.throws(
  () => resolveWindowsPerUserPaths({
    platform: 'win32',
    env: {
      ...env,
      AGENTOC_INSTANCE_ROOT: paths.instanceRoot,
      AGENTOC_PROVIDER_HOMES_DIR: 'C:\\other-instance\\provider-homes',
    },
  }),
  (error) => error.code === 'WINDOWS_RUNTIME_PATH_INVALID',
);
for (const pathField of ['AGENTOC_RUN_SPOOL_DIR', 'AGENTOC_PROVIDER_HOMES_DIR', 'AGENTOC_WORK_ROOT_DIR', 'AGENTOC_PLATFORM_SKILLS_DIR']) {
  assert.throws(
    () => resolveWindowsPerUserPaths({
      platform: 'win32',
      env: { ...env, [pathField]: 'C:\\Users\\Alice\\AppData\\Local\\AgentoC\\instances\\other\\data' },
    }),
    (error) => error.code === 'WINDOWS_RUNTIME_PATH_INVALID',
    `external ${pathField} must not cross the instance boundary`,
  );
}
assert.throws(
  () => resolveWindowsPerUserPaths({
    platform: 'win32',
    env: { ...env, AGENTOC_PROVIDER_HOMES_DIR: 'C:\\Users\\Alice\\AppData\\Local\\AgentoC\\instances\\owner workspace\\config' },
  }),
  (error) => error.code === 'WINDOWS_RUNTIME_PATH_INVALID',
  'provider homes must not overlap config state',
);

const safeBoundary = assessWindowsPathBoundary({
  expectedRoot: paths.workspaceDir,
  configuredPath: 'C:\\Users\\Alice\\AppData\\Local\\AgentoC\\instances\\owner workspace\\workspace\\input file.txt',
  canonicalPath: 'C:\\Users\\Alice\\AppData\\Local\\AgentoC\\instances\\owner workspace\\workspace\\input file.txt',
  reparsePoint: false,
});
assert.equal(safeBoundary.ok, true);
assert.equal(assessWindowsPathBoundary({
  expectedRoot: paths.workspaceDir,
  configuredPath: 'C:\\Users\\Alice\\AppData\\Local\\AgentoC\\instances\\owner workspace\\workspace\\linked',
  canonicalPath: 'C:\\outside\\secret.txt',
  reparsePoint: true,
}).reason, 'canonical-path-outside-root');
assert.equal(assessWindowsPathBoundary({
  expectedRoot: paths.workspaceDir,
  configuredPath: 'C:\\Users\\Alice\\AppData\\Local\\AgentoC\\instances\\owner workspace\\workspace\\unknown',
  canonicalPath: 'C:\\Users\\Alice\\AppData\\Local\\AgentoC\\instances\\owner workspace\\workspace\\unknown',
}).reason, 'reparse-fact-unverified');

const endpointA = deriveWindowsEndpointName({ instanceRoot: paths.instanceRoot, instanceId: 'inst_a' });
const endpointB = deriveWindowsEndpointName({ instanceRoot: paths.instanceRoot, instanceId: 'inst_b' });
const endpointAFromCaseVariant = deriveWindowsEndpointName({
  instanceRoot: paths.instanceRoot.toUpperCase(),
  instanceId: 'inst_a',
});
const endpointAFromPathVariant = deriveWindowsEndpointName({
  instanceRoot: `${paths.instanceRoot}\\.\\`,
  instanceId: 'inst_a',
});
assert.match(endpointA, /^\\\\\.\\pipe\\agentoc-[0-9a-f-]+$/);
assert.notEqual(endpointA, endpointB);
assert.equal(endpointAFromCaseVariant, endpointA, 'endpoint identity must be stable across Windows root casing');
assert.equal(endpointAFromPathVariant, endpointA, 'endpoint identity must be stable across path normalization');
assert.notEqual(
  endpointA,
  deriveWindowsEndpointName({ instanceRoot: paths.instanceRoot, instanceId: 'INST_A' }),
  'distinct instance identities must not collide by case folding',
);
assert.throws(
  () => deriveWindowsEndpointName({ instanceRoot: paths.instanceRoot, instanceId: 'inst_a\nforeign' }),
  (error) => error.code === 'WINDOWS_RUNTIME_PATH_INVALID',
);

const root = await mkdtemp(join(tmpdir(), 'agentoc-p0-1-'));
const ownershipPath = join(root, 'runtime', 'instance-ownership.json');
const owner = await acquireInstanceOwnership({
  filePath: ownershipPath,
  instanceId: 'inst_a',
  endpointName: endpointA,
  pid: 4242,
  token: 'owner-token',
});
assert.equal((await readInstanceOwnership(ownershipPath)).token, 'owner-token');
await assert.rejects(
  acquireInstanceOwnership({ filePath: ownershipPath, instanceId: 'inst_a', endpointName: endpointA, pid: 4243 }),
  (error) => error.code === INSTANCE_OWNERSHIP_ALREADY_ACTIVE,
);
await writeFile(ownershipPath, 'not valid json\n', 'utf8');
await assert.rejects(
  acquireInstanceOwnership({ filePath: ownershipPath, instanceId: 'inst_a', endpointName: endpointA, pid: 4243 }),
  (error) => error.code === INSTANCE_OWNERSHIP_ALREADY_ACTIVE && error.markerState === 'unverified',
);
await writeFile(ownershipPath, `${JSON.stringify(owner)}\n`, 'utf8');
await assert.rejects(
  owner.release({ removeEndpoint: async (releasedOwner) => {
    assert.equal(releasedOwner.token, 'owner-token');
    throw new Error('foreign endpoint must not be touched');
  } }),
  /foreign endpoint must not be touched/,
);
assert.equal((await readInstanceOwnership(ownershipPath)).token, 'owner-token');
await writeFile(
  ownershipPath,
  `${JSON.stringify({ ...owner, token: 'foreign-token' })}\n`,
  'utf8',
);
await assert.rejects(
  owner.release({ removeEndpoint: async () => { throw new Error('foreign endpoint must not be touched'); } }),
  (error) => error.code === INSTANCE_OWNERSHIP_MISMATCH,
);
assert.equal((await readInstanceOwnership(ownershipPath)).token, 'foreign-token');
await writeFile(
  ownershipPath,
  `${JSON.stringify(owner)}\n`,
  'utf8',
);
let endpointRemovalCount = 0;
const [firstRelease, secondRelease] = await Promise.all([
  owner.release({ removeEndpoint: async () => { endpointRemovalCount += 1; } }),
  owner.release({ removeEndpoint: async () => { endpointRemovalCount += 1; } }),
]);
assert.equal(firstRelease.ok, true);
assert.equal(secondRelease.ok, true);
assert.equal(endpointRemovalCount, 1, 'concurrent shutdown signals must remove the endpoint once');
assert.equal(await readInstanceOwnership(ownershipPath), null);
await rm(root, { recursive: true, force: true });

console.log('test-windows-per-user-runtime: PASS');
