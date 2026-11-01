#!/usr/bin/env node
// Approved-action session execution must use the Windows executable resolver
// and the managed Job Object spawn contract. This runs off-win32 with injected
// seams; the native execution proof is in live-windows-approved-action-executor.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { executeApprovedSessionCommand } from '../chat/approved-action-executor.mjs';
import {
  buildSpawnSpecFromResolvedPath,
  WINDOWS_CMD_EXECUTABLE,
} from '../lib/executable-resolution.mjs';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.deepEqual(actual, expected, `failed: ${label}`);
  passed += 1;
}

function fakeChild({ stdout = '', stderr = '', code = 0, signal = null, delayMs = 0 } = {}) {
  const child = new EventEmitter();
  child.pid = 43210;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const timer = setTimeout(() => {
    if (stdout) child.stdout.end(stdout);
    else child.stdout.end();
    if (stderr) child.stderr.end(stderr);
    else child.stderr.end();
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  }, delayMs);
  timer.unref?.();
  return child;
}

// A .cmd action is resolved as an absolute path and launched through the
// explicit cmd.exe wrapper, while the managed-spawn facade owns the process.
{
  let resolvedRequest = null;
  let spawnCall = null;
  const result = await executeApprovedSessionCommand({
    action: { cwd: 'C:\\work' },
    argv: ['agent.cmd', '--label', 'a&b'],
    resolveExecutableImpl: async (command, options) => {
      resolvedRequest = { command, options };
      return 'C:\\tools\\agent.cmd';
    },
    buildSpawnSpecImpl: ({ file, args, cwd }) => buildSpawnSpecFromResolvedPath(file, args, { cwd }),
    spawnManagedImpl: async (spec, options) => {
      spawnCall = { spec, options };
      return fakeChild({ stdout: 'approved-session-ok' });
    },
  });
  eq('resolver receives the approved executable name', resolvedRequest.command, 'agent.cmd');
  eq('resolver receives the approved cwd', resolvedRequest.options.cwd, 'C:\\work');
  eq('resolved .cmd uses explicit cmd.exe', spawnCall.spec.file, WINDOWS_CMD_EXECUTABLE);
  eq('resolved .cmd keeps fixed wrapper argv', spawnCall.spec.args, [
    '/d', '/s', '/c', '""C:\\tools\\agent.cmd" "--label" "a^&b""',
  ]);
  eq('managed spawn requests piped output and ignored stdin', spawnCall.options.stdio, ['ignore', 'pipe', 'pipe']);
  check('managed .cmd session execution succeeds', result.ok === true);
  eq('managed .cmd session output is captured', result.resultRef.stdout, 'approved-session-ok');
}

// Resolution failure must fail before a managed child can be created.
{
  let spawnCalls = 0;
  const result = await executeApprovedSessionCommand({
    action: { cwd: 'C:\\work' },
    argv: ['missing.cmd'],
    resolveExecutableImpl: async () => null,
    spawnManagedImpl: async () => {
      spawnCalls += 1;
      throw new Error('must not spawn');
    },
  });
  check('missing approved executable fails closed', result.ok === false);
  check('missing approved executable does not spawn', spawnCalls === 0);
  check('missing approved executable explains the failure', /not found/.test(result.resultRef.error));
}

// Non-zero exits preserve stdout/stderr and return a structured failure.
{
  const result = await executeApprovedSessionCommand({
    action: { cwd: 'C:\\work' },
    argv: ['agent.exe'],
    resolveExecutableImpl: async () => 'C:\\tools\\agent.exe',
    spawnManagedImpl: async () => fakeChild({ stderr: 'failure-output', code: 7 }),
  });
  check('managed session non-zero exit fails', result.ok === false);
  eq('managed session preserves exit code', result.resultRef.exitCode, 7);
  eq('managed session preserves stderr', result.resultRef.stderr, 'failure-output');
}

// A timeout must invoke the tree terminator, not just a root-process kill.
{
  let terminated = null;
  let child;
  const resultPromise = executeApprovedSessionCommand({
    action: { cwd: 'C:\\work' },
    argv: ['agent.exe'],
    timeoutMs: 1_000,
    resolveExecutableImpl: async () => 'C:\\tools\\agent.exe',
    spawnManagedImpl: async () => {
      child = fakeChild({ delayMs: 10_000 });
      return child;
    },
    terminateProcessTreeImpl: async (proc, signal) => {
      terminated = { proc, signal };
      proc.stdout.end();
      proc.stderr.end();
      proc.emit('close', null, signal);
    },
  });
  const result = await resultPromise;
  check('managed session timeout fails', result.ok === false);
  eq('managed session timeout reports timeout', result.resultRef.error, 'Approved action timed out');
  eq('managed session timeout uses tree termination', terminated.proc, child);
  eq('managed session timeout uses cooperative signal contract', terminated.signal, 'SIGTERM');
}

console.log(`test-approved-action-executor-windows: ${passed} checks passed`);
