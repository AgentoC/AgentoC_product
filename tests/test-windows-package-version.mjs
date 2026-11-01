import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { WINDOWS_POWERSHELL_EXECUTABLE } from '../lib/executable-resolution.mjs';

if (process.platform !== 'win32') {
  console.log('SKIP: Windows package version writer requires Windows');
  process.exit(0);
}
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'agentoc-package-version-'));
const script = resolve('packaging/windows/write-package-version.ps1');
const write = (version) => exec(WINDOWS_POWERSHELL_EXECUTABLE, [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
  '-PayloadRoot', root, '-Version', version,
], { timeout: 10000, windowsHide: true });
try {
  await write('0.0.1.0');
  assert.equal(await readFile(join(root, '.agentoc-package-version'), 'utf8'), '0.0.1\n');
  await write('0.3.18.60');
  assert.equal(await readFile(join(root, '.agentoc-package-version'), 'utf8'), '0.3.18.60\n');
  await assert.rejects(write('0.0.1'), /four numeric components/);
  console.log('Windows package version marker: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
