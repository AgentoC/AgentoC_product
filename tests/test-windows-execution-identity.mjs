import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertOrdinaryWindowsExecutionIdentity as admit,
  readWindowsExecutionIdentity,
} from '../lib/windows-execution-identity.mjs';
import { spawnSupervisedRunner } from '../chat/runner-supervisor-daemon.mjs';

const ordinary = { version: 1, sid: 'S-1-5-21-100-200-300-1001',
  isSystem: false, isAdministrator: false, integrityRid: 8192 };

test('non-Windows paths do not use the Windows token probe', async () => {
  await admit({ platform: 'linux', readIdentityImpl() { throw new Error('unexpected probe'); } });
});

test('medium integrity split-token user is accepted without an admin-group claim', async () => {
  assert.equal(await admit({ platform: 'win32', readIdentityImpl: async () => ordinary }), ordinary);
});

for (const [name, patch] of [
  ['SYSTEM', { sid: 'S-1-5-18', isSystem: true, integrityRid: 16384 }],
  ['local service', { sid: 'S-1-5-19' }],
  ['network service', { sid: 'S-1-5-20' }],
  ['enabled administrator', { isAdministrator: true }],
  ['High integrity', { integrityRid: 12288 }],
  ['System integrity without an administrator flag', { integrityRid: 16384 }],
]) {
  test(`${name} is rejected before the supervisor spawns a runner`, async () => {
    let spawned = false;
    await assert.rejects(spawnSupervisedRunner('run_identity_rejected', {
      platform: 'win32',
      assertExecutionIdentityImpl: () => admit({ platform: 'win32', readIdentityImpl: async () => ({ ...ordinary, ...patch }) }),
      spawnImpl() { spawned = true; throw new Error('must never spawn'); },
    }), { code: 'WINDOWS_EXECUTION_IDENTITY_UNSAFE' });
    assert.equal(spawned, false);
  });
}

test('missing, malformed and localized/unsupported probe output fails closed', async () => {
  for (const stdout of ['', '{}', 'not JSON', JSON.stringify({ ...ordinary, integrityRid: '8192' })]) {
    await assert.rejects(readWindowsExecutionIdentity({ execFileImpl: async () => ({ stdout }) }),
      { code: 'WINDOWS_EXECUTION_IDENTITY_UNAVAILABLE' });
  }
  await assert.rejects(readWindowsExecutionIdentity({ execFileImpl: async () => { throw new Error('PRIVATE probe stderr'); } }),
    error => error.code === 'WINDOWS_EXECUTION_IDENTITY_UNAVAILABLE' && !error.message.includes('PRIVATE'));
});

test('a fixed absolute Windows probe is bounded and accepts UTF-8 BOM output', async () => {
  let call;
  assert.deepEqual(await readWindowsExecutionIdentity({ execFileImpl: async (...args) => {
    call = args;
    return { stdout: '\uFEFF' + JSON.stringify(ordinary) };
  } }), ordinary);
  assert.match(call[0], /^[A-Za-z]:\\.*\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.ok(call[1].includes('-NonInteractive'));
  assert.equal(call[2].timeout, 10000);
  assert.equal(call[2].env.PATHEXT, '.COM;.EXE;.BAT;.CMD');
});

test('real current Windows token is accepted only when ordinary', { skip: process.platform !== 'win32' }, async () => {
  const identity = await readWindowsExecutionIdentity();
  const unsafe = identity.isSystem || identity.isAdministrator || identity.integrityRid >= 12288
    || ['S-1-5-18', 'S-1-5-19', 'S-1-5-20'].includes(identity.sid);
  if (unsafe) await assert.rejects(admit(), { code: 'WINDOWS_EXECUTION_IDENTITY_UNSAFE' });
  else assert.deepEqual(await admit(), identity);
});
