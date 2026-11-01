#!/usr/bin/env node
/**
 * Adversarial acceptance I-3 / I-4: the winget/msiexec executable path is
 * server-owned configuration. A worker must not be able to change it via env,
 * CLI, or request payload, and a deployment override must be an absolute
 * Windows path (rejected otherwise, fail-closed).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { RUNNER_ENV_ALLOWLIST, pickRunnerEnvAllowlist } from '../lib/runner-env.mjs';
import { buildWindowsWingetInstallInvocation, WINGET_EXECUTABLE } from '../chat/semantic-windows-adapter.mjs';

let passed = 0;
function check(label, value) {
  assert.ok(value, `failed: ${label}`);
  passed += 1;
}
function eq(label, actual, expected) {
  assert.equal(actual, expected, `failed: ${label}`);
  passed += 1;
}

// ── I-3 env: a worker's AGENTOC_WINGET_EXECUTABLE never reaches a Run ─────────
check('runner env allowlist does not carry AGENTOC_WINGET_EXECUTABLE',
  !RUNNER_ENV_ALLOWLIST.includes('AGENTOC_WINGET_EXECUTABLE'));
check('runner env allowlist does not carry AGENTOC_MSIEXEC_EXECUTABLE',
  !RUNNER_ENV_ALLOWLIST.includes('AGENTOC_MSIEXEC_EXECUTABLE'));
const picked = pickRunnerEnvAllowlist({
  AGENTOC_WINGET_EXECUTABLE: 'C:\\evil\\winget.exe',
  AGENTOC_MSIEXEC_EXECUTABLE: 'C:\\evil\\msiexec.exe',
  PATH: 'C:\\Windows\\System32',
  HOME: 'C:\\Users\\x',
});
check('allowlist pick strips a worker-set AGENTOC_WINGET_EXECUTABLE', picked.AGENTOC_WINGET_EXECUTABLE === undefined);
check('allowlist pick strips a worker-set AGENTOC_MSIEXEC_EXECUTABLE', picked.AGENTOC_MSIEXEC_EXECUTABLE === undefined);

// ── I-3 payload: a request can supply package semantics but never an executable
//    the winget builder derives the executable from the server constant, so a
//    forged adapterInput.executable field is ignored.
const forgedCapability = {
  adapter: 'windows-winget-install/v1',
  operations: [{
    platform: 'win32',
    primaryAction: 'package.install',
    executionClass: 'host',
    effects: ['process.execute'],
    adapterInput: {
      manager: 'winget',
      source: 'winget',
      exact: true,
      packages: ['Git.Git'],
      requestedVersions: [''],
      resolvedVersions: ['2.0'],
      sourceTrust: 'configured',
      executable: 'C:\\evil\\forged.exe', // must be ignored
      argv: ['--evil'],                   // must be ignored
    },
  }],
};
const invocation = buildWindowsWingetInstallInvocation(forgedCapability);
eq('invocation executable is the server constant, never the forged payload value',
  invocation.executable, WINGET_EXECUTABLE);
check('forged argv is ignored', !invocation.argv.includes('--evil'));

// ── I-4 override validation: absolute-path-only, fail closed at import ─────────
const importWith = (env) => {
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', "import('./chat/semantic-windows-adapter.mjs')"], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, stderr: String(error?.stderr || '') };
  }
};
eq('relative override is rejected', importWith({ AGENTOC_WINGET_EXECUTABLE: 'winget.exe' }).ok, false);
eq('UNC override is rejected', importWith({ AGENTOC_WINGET_EXECUTABLE: '\\\\server\\share\\winget.exe' }).ok, false);
check('valid absolute override imports', importWith({ AGENTOC_WINGET_EXECUTABLE: 'C:\\Tools\\winget.exe' }).ok === true);

console.log(`executor-executable-boundary: ${passed} checks passed`);
