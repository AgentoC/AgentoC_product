#!/usr/bin/env node
// Same-user ordinary runner boundary contract (narrow, low-risk).
//
// Verifies:
//  1. same-user mode resolves to the trusted control service user and rejects
//     conflicting runner-user overrides; explicit compatibility mode retains
//     the old resolution order for migration coverage.
//  2. resolveRunnerGroup resolution: AGENTOC_RUNNER_GROUP env -> same-name
//     group -> shared agentoc-runners group.
//  3. Socket placement: the lifecycle broker socket stays in the control-plane
//     CONFIG_DIR (root creates it and chowns it to the control user); the
//     supervisor socket lives in the runner state root /var/lib/agentoc-run.
//     The packaged agentoc.env points at both.
//  4. The directory permission model keeps control auth.json unreadable by the runner
//     group, gives the runner-accessible subtrees (results / provider-homes,
//     under /var/lib/agentoc-run) group read/write, and makes the control
//     config dir NOT traversable by the runner group at all.
//  5. postinst carries the same-user service/supervisor/socket overrides, the
//     relocated runner subtrees and the compatibility runner-user marker.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// Import order matters: DEFAULT_LIFECYCLE_SOCKET_PATH / CONFIG_DIR read the env
// at module load, so make sure the production socket env is not ambient in this
// process.
delete process.env.AGENTOC_RUNNER_LIFECYCLE_SOCKET;
delete process.env.AGENTOC_RUNNER_SUPERVISOR_SOCKET;

const { CONFIG_DIR } = await import('../lib/config.mjs');
const {
  resolveRunnerUser,
  resolveRunnerGroup,
  resolveRunnerInheritedGroups,
  resolveControlUser,
  DEFAULT_LIFECYCLE_SOCKET_PATH,
} = await import('../scripts/runner-lifecycle-broker.mjs');
const { DEFAULT_SUPERVISOR_SOCKET_PATH } = await import('../chat/runner-supervisor-daemon.mjs');

const tmpRoot = await mkdtemp(join(tmpdir(), 'agentoc-runner-boundary-'));
const savedEnv = new Map();
function saveEnv(...keys) {
  for (const key of keys) savedEnv.set(key, process.env[key]);
}
function restoreEnv() {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
}

try {
  // ── 1) same-user identity + explicit compatibility order ─────────────────
  saveEnv('AGENTOC_RUNNER_USER', 'AGENTOC_RUNNER_GROUP', 'AGENTOC_RUNNER_SAME_USER');
  const serviceUserFile = join(tmpRoot, 'service-user');
  await writeFile(serviceUserFile, 'svc-owner\n');
  const runnerUserFile = join(tmpRoot, 'runner-user');
  await writeFile(runnerUserFile, 'file-runner\n');
  assert.equal(await resolveRunnerUser({
    file: runnerUserFile,
    controlUserFile: serviceUserFile,
    environment: { AGENTOC_RUNNER_SAME_USER: '1' },
    getentImpl: async () => { throw new Error('same-user mode must not probe a dedicated user'); },
  }), 'svc-owner', 'same-user mode must use the trusted control service user');
  await assert.rejects(
    () => resolveRunnerUser({
      file: runnerUserFile,
      controlUserFile: serviceUserFile,
      environment: { AGENTOC_RUNNER_SAME_USER: '1', AGENTOC_RUNNER_USER: 'env-runner' },
    }),
    /rejects AGENTOC_RUNNER_USER=env-runner/,
    'same-user mode must reject a conflicting identity override',
  );

  // Explicit compatibility mode retains the old order for upgrade/migration
  // tests, but is not the package default.
  process.env.AGENTOC_RUNNER_SAME_USER = '0';
  process.env.AGENTOC_RUNNER_USER = 'env-runner';
  assert.equal(await resolveRunnerUser({
    file: join(tmpRoot, 'no-runner-user'),
    getentImpl: async () => { throw new Error('getent must not be probed when env wins'); },
    readFileImpl: async () => { throw new Error('runner-user file must not be read when env wins'); },
  }), 'env-runner', 'compatibility mode keeps explicit runner user support');
  delete process.env.AGENTOC_RUNNER_USER;

  // runner-user file is second in compatibility mode, and its value must exist.
  assert.equal(await resolveRunnerUser({
    file: runnerUserFile,
    environment: { AGENTOC_RUNNER_SAME_USER: '0' },
    getentImpl: async () => ({ stdout: 'file-runner:x:1000:1000::/var/lib/agentoc-run:/bin/sh\n' }),
  }), 'file-runner', 'runner-user file must be honoured when the user exists');

  // A file value that does not exist falls through to the agentoc-runner probe.
  await writeFile(runnerUserFile, 'ghost-runner\n');
  assert.equal(await resolveRunnerUser({
    file: runnerUserFile,
    environment: { AGENTOC_RUNNER_SAME_USER: '0' },
    getentImpl: async (cmd, args) => (
      args[1] === 'agentoc-runner'
        ? { stdout: 'agentoc-runner:x:998:998::/var/lib/agentoc-run:/usr/sbin/nologin\n' }
        : { stdout: '' }
    ),
  }), 'agentoc-runner', 'a non-existent file user must fall through to the agentoc-runner default');

  // agentoc-runner default when no file and getent reports it exists.
  assert.equal(await resolveRunnerUser({
    file: join(tmpRoot, 'missing-runner-user'),
    environment: { AGENTOC_RUNNER_SAME_USER: '0' },
    getentImpl: async () => ({ stdout: 'agentoc-runner:x:998:998::/var/lib/agentoc-run:/usr/sbin/nologin\n' }),
  }), 'agentoc-runner', 'agentoc-runner must be the default when it exists');

  // Compatibility fallback to the control service user when agentoc-runner is absent.
  assert.equal(await resolveRunnerUser({
    file: join(tmpRoot, 'missing-runner-user'),
    controlUserFile: serviceUserFile,
    environment: { AGENTOC_RUNNER_SAME_USER: '0' },
    getentImpl: async () => ({ stdout: '' }),
  }), 'svc-owner', 'must fall back to the control service user when agentoc-runner is absent');

  assert.equal(
    await resolveControlUser({ file: join(tmpRoot, 'missing'), readFileImpl: readFile }),
    'agentoc',
    'control user must default to agentoc',
  );

  // ── 2) resolveRunnerGroup order ─────────────────────────────────────────
  process.env.AGENTOC_RUNNER_GROUP = 'custom-group';
  assert.equal(
    await resolveRunnerGroup('whatever', { getentImpl: async () => { throw new Error('no probe'); } }),
    'custom-group',
    'AGENTOC_RUNNER_GROUP env must win',
  );
  delete process.env.AGENTOC_RUNNER_GROUP;
  assert.equal(
    await resolveRunnerGroup('runner-user', { getentImpl: async () => ({ stdout: 'runner-user:x:1000:\n' }) }),
    'runner-user',
    'a same-name group wins for legacy layouts',
  );
  assert.equal(
    await resolveRunnerGroup('agentoc-runner', { getentImpl: async () => ({ stdout: '' }) }),
    'agentoc-runners',
    'defaults to the shared agentoc-runners group',
  );
  await assert.rejects(
    () => resolveRunnerGroup('pinggu', {
      environment: { AGENTOC_RUNNER_SAME_USER: '1', AGENTOC_RUNNER_GROUP: 'agentoc-runners' },
    }),
    /rejects AGENTOC_RUNNER_GROUP=agentoc-runners/,
    'same-user mode must keep the service primary group',
  );
  assert.deepEqual(
    await resolveRunnerInheritedGroups('desktop-owner', {
      environment: {},
      execFileImpl: async () => ({ stdout: 'desktop-owner sudo docker agentoc-privileged users\n' }),
      readFileImpl: async () => { throw new Error('live group lookup should win'); },
    }),
    ['desktop-owner', 'users'],
    'runner inherits ordinary service-user groups but filters privilege channels',
  );
  assert.deepEqual(
    await resolveRunnerInheritedGroups('desktop-owner', {
      environment: { AGENTOC_RUNNER_INHERITED_GROUPS: 'desktop-owner sudo docker agentoc-privileged' },
      execFileImpl: async () => { throw new Error('explicit group override must win'); },
    }),
    ['desktop-owner'],
    'explicit inherited-group override remains deny-listed',
  );
  restoreEnv();

  // ── 3) socket placement: lifecycle in CONFIG_DIR, supervisor in runner root ──
  assert.equal(
    DEFAULT_LIFECYCLE_SOCKET_PATH,
    join(CONFIG_DIR, 'runner-lifecycle.sock'),
    'lifecycle socket must default under CONFIG_DIR',
  );
  assert.ok(
    DEFAULT_LIFECYCLE_SOCKET_PATH.startsWith(CONFIG_DIR),
    'lifecycle socket must stay under the control CONFIG_DIR',
  );
  assert.ok(
    !DEFAULT_LIFECYCLE_SOCKET_PATH.includes('/run/agentoc/'),
    'lifecycle socket must not be relocated to /run/agentoc',
  );
  assert.equal(
    DEFAULT_SUPERVISOR_SOCKET_PATH,
    '/var/lib/agentoc-run/runner-supervisor.sock',
    'supervisor socket must live in the runner state root, not the control CONFIG_DIR',
  );
  assert.ok(
    !DEFAULT_SUPERVISOR_SOCKET_PATH.includes('/run/agentoc/'),
    'supervisor socket must not be relocated to /run/agentoc',
  );
  assert.ok(
    !DEFAULT_SUPERVISOR_SOCKET_PATH.startsWith(CONFIG_DIR),
    'supervisor socket must not stay in the control CONFIG_DIR',
  );

  const agentocEnv = await readFile(join(REPO_ROOT, 'packaging/deb/agentoc.env'), 'utf8');
  assert.match(agentocEnv, /^AGENTOC_RUNNER_SAME_USER=1$/m, 'packaged installs must default to same-user mode');
  assert.match(agentocEnv, /AGENTOC_RUNNER_LIFECYCLE_SOCKET=\/var\/lib\/agentoc\/config\/runner-lifecycle\.sock/);
  assert.match(agentocEnv, /AGENTOC_RUNNER_SUPERVISOR_SOCKET=\/var\/lib\/agentoc-run\/runner-supervisor\.sock/);
  assert.ok(
    !agentocEnv.includes('/run/agentoc/runner-'),
    'agentoc.env must not relocate runner sockets to /run/agentoc',
  );
  // P0-C: the runner-accessible subtrees are env-targeted under the runner root.
  assert.match(agentocEnv, /AGENTOC_RUN_SPOOL_DIR=\/var\/lib\/agentoc-run\/results/);
  assert.match(agentocEnv, /AGENTOC_PROVIDER_HOMES_DIR=\/var\/lib\/agentoc-run\/provider-homes/);

  // ── 4) directory permission model (simulated on a temp tree) ────────────
  // Simulates the P0-C layout: the control core (/var/lib/agentoc + config) is
  // NOT traversable by the runner group at all (no o+x), while the runner-
  // accessible subtrees (results + provider-homes) live under /var/lib/agentoc-run
  // and are group read/write for the shared agentoc-runners group.
  const stateRoot = join(tmpRoot, 'var-lib-agentoc');
  const configRoot = join(stateRoot, 'config');
  const authFile = join(configRoot, 'auth.json');
  const runnerRoot = join(tmpRoot, 'var-lib-agentoc-run');
  const resultsDir = join(runnerRoot, 'results');
  const providerHomes = join(runnerRoot, 'provider-homes');
  await mkdir(configRoot, { recursive: true });
  await mkdir(resultsDir, { recursive: true });
  await mkdir(providerHomes, { recursive: true });
  await writeFile(authFile, '{"username":"owner"}');
  // Control core: service-user:service-group 0750, no group/other access.
  await chmod(stateRoot, 0o750);
  await chmod(configRoot, 0o750);
  // Runner state root + subtrees: group read/write for agentoc-runners.
  await chmod(runnerRoot, 0o750);
  await chmod(resultsDir, 0o770);
  await chmod(providerHomes, 0o770);
  await chmod(authFile, 0o600);
  const mode = (s) => s.mode & 0o7777;
  assert.equal(
    mode(await stat(stateRoot)) & 0o007,
    0,
    '/var/lib/agentoc must not be traversable by others/runners',
  );
  assert.equal(
    mode(await stat(configRoot)) & 0o007,
    0,
    'config must not be traversable by others/runners',
  );
  assert.equal(
    mode(await stat(authFile)) & 0o077,
    0,
    'auth.json must be unreadable by group and others',
  );
  assert.equal(
    mode(await stat(resultsDir)) & 0o070,
    0o070,
    'results must be group read/write',
  );
  assert.equal(
    mode(await stat(providerHomes)) & 0o070,
    0o070,
    'provider-homes must be group read/write',
  );

  // ── 5) postinst + units carry the same-user/P0-C statements ─────────────
  const postinst = await readFile(join(REPO_ROOT, 'packaging/deb/postinst'), 'utf8');
  assert.match(postinst, /addgroup --system agentoc-runners/);
  assert.match(postinst, /adduser --system --ingroup agentoc-runners/);
  assert.match(postinst, /agentoc-runner/);
  assert.match(postinst, /\/var\/lib\/agentoc-run/);
  // P0-C: the runner subtrees move out of the control CONFIG_DIR; no traverse
  // ACL is granted, and the migration helper relocates any legacy data.
  assert.match(postinst, /\/var\/lib\/agentoc-run\/results/);
  assert.match(postinst, /\/var\/lib\/agentoc-run\/provider-homes/);
  assert.match(postinst, /relocate-runner-subtrees\.mjs/);
  assert.match(postinst, /0640/, 'runner provider files must converge to group-readable mode');
  assert.ok(
    !postinst.includes('ensure_runner_config_traverse'),
    'postinst must not grant the runner group config traverse access',
  );
  assert.ok(
    !/install -d[^\n]*\/var\/lib\/agentoc\/config\/chat-runs/.test(postinst),
    'postinst must not create a legacy spool dir under config',
  );
  assert.match(postinst, /User=\$service_user\nGroup=\$service_group/);
  assert.match(postinst, /agentoc-runner-supervisor\.socket\.d/);
  assert.match(postinst, /SocketUser=\$service_user\nSocketGroup=\$service_group/);
  assert.ok(
    !/install -d[^\n]*\/run\/agentoc/.test(postinst),
    'postinst must not create a shared /run/agentoc runner runtime dir',
  );

  const supervisorUnit = await readFile(
    join(REPO_ROOT, 'packaging/deb/agentoc-runner-supervisor.service'),
    'utf8',
  );
  assert.match(supervisorUnit, /^User=agentoc$/m, 'package fallback must be the service-compatible account');
  assert.match(supervisorUnit, /^Group=agentoc$/m, 'package fallback group must match the account');
  // The long-lived supervisor imports the shared config module to resolve its
  // launch paths, so the package template keeps /var/lib/agentoc read-only.
  // The actual Run boundary is stricter: the lifecycle transient unit masks
  // /var/lib/agentoc/config dynamically (covered above in the broker test).
  assert.match(
    supervisorUnit,
    /^InaccessiblePaths=\/etc\/agentoc \/var\/log\/agentoc \/run\/agentoc /m,
    'supervisor must mask system config/log/socket roots',
  );
  assert.match(
    supervisorUnit,
    /^ReadOnlyPaths=\/var\/lib\/agentoc$/m,
    'supervisor config access must be read-only',
  );
  assert.match(postinst, /runner-groups/);
  assert.match(postinst, /write_runner_inherited_groups/);
  assert.match(supervisorUnit, /^ReadWritePaths=\/var\/lib\/agentoc-run/m, 'supervisor must write its socket in the runner state root');
  const supervisorSocket = await readFile(
    join(REPO_ROOT, 'packaging/deb/agentoc-runner-supervisor.socket'),
    'utf8',
  );
  assert.match(supervisorSocket, /^SocketUser=agentoc$/m);
  assert.match(supervisorSocket, /^SocketGroup=agentoc$/m);

  const lifecycleUnit = await readFile(
    join(REPO_ROOT, 'packaging/deb/agentoc-runner-lifecycle.service'),
    'utf8',
  );
  assert.ok(
    !lifecycleUnit.includes('/run/agentoc'),
    'lifecycle unit must not require a /run/agentoc runtime dir',
  );

  console.log('test-runner-user-boundary: PASS');
} finally {
  restoreEnv();
  await rm(tmpRoot, { recursive: true, force: true });
}
