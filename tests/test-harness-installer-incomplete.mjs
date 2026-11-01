import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform !== 'win32') {
  console.log('SKIP: bundled Windows installer guard');
  process.exit(0);
}
const root = await mkdtemp(join(tmpdir(), 'agentoc-broken-installer-'));
const payload = join(root, 'broken payload');
await mkdir(payload);
await writeFile(join(payload, 'node.exe'), 'fixture: must never execute');
await writeFile(join(payload, 'npm.cmd'), '@echo off\r\nexit /b 99\r\n');
process.env.AGENTOC_CONFIG_DIR = join(root, 'config');
process.env.AGENTOC_HARNESS_ROOT = join(root, 'harnesses');
process.env.AGENTOC_NPM_COMMAND = join(payload, 'npm.cmd');
process.env.AGENTOC_ALLOW_EXTERNAL_TEST_INSTANCE_OVERRIDES = '1';
process.env.AGENTOC_HARNESS_POLICY_URL = 'http://invalid.test';
delete process.env.AGENTOC_INSTANCE_ROOT;
const { upgradeHarness } = await import('../lib/harness-registry.mjs');
await assert.rejects(upgradeHarness('codex', '0.153.4'),
  /HARNESS_INSTALLER_RUNTIME_INCOMPLETE:.*npm-cli\.js.*Repair or update/s);
console.log('PASS: incomplete bundled npm is rejected before invoking installer; actionable repair message');
