import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileWindowsGitStatus } from '../chat/windows-git-status.mjs';
import { resolveWin32ExecutablePathAsync } from '../lib/executable-resolution.mjs';

if (process.platform !== 'win32') {
  console.log('windows-git-status: skipped (requires Windows PowerShell)');
  process.exit(0);
}
const root = mkdtempSync(path.join(tmpdir(), 'agentoc-git-status-'));
try {
  assert.equal(await compileWindowsGitStatus('git status', { parse: async () => ({ commands: [] }) }), null);
  assert.equal(await compileWindowsGitStatus('git status', { parse: async () => { throw new Error('parser unavailable'); } }), null);
  const git = await resolveWin32ExecutablePathAsync('git');
  assert.ok(git && path.win32.isAbsolute(git), 'real Git executable required');
  execFileSync(git, ['init', '-q'], { cwd: root, windowsHide: true });
  writeFileSync(path.join(root, '普通 file.txt'), 'fixture');
  for (const shell of [undefined, process.env.AGENTOC_TEST_PWSH].filter((value, index) => value || index === 0)) {
    for (const [source, args] of [
      ['git status', ['status']], ['git status --short', ['status', '--short']],
      ['git.exe status -sb', ['status', '-sb']], ['git status --porcelain=v1 -uno', ['status', '--porcelain=v1', '-uno']],
      ['git status --untracked-files=all --branch', ['status', '--untracked-files=all', '--branch']],
    ]) {
      const compiled = await compileWindowsGitStatus(source, { executable: shell });
      assert.deepEqual(compiled, { kind: 'git-status', args }, source);
      const safeArgs = ['-c', 'core.fsmonitor=false', '--no-optional-locks'];
      const original = execFileSync(git, [...safeArgs, ...args], { cwd: root, windowsHide: true });
      const reconstructed = execFileSync(git, [...safeArgs, ...compiled.args], { cwd: root, windowsHide: true });
      assert.deepEqual(reconstructed, original, source);
    }
    for (const source of [
      'git -c core.fsmonitor=evil status', 'git --exec-path=evil status', 'git -C other status',
      'git status --help', 'git status -- .', 'git status file.txt', 'git status --porcelain=$(whoami)',
      'git status; Write-Output evil', 'git status | Write-Output', 'git status > output.txt',
      'git status --untracked-files=invalid', 'git status --ignored=invalid', 'git log --short',
      "& 'git.exe' status", 'git status -s; Remove-Item file.txt',
    ]) assert.equal(await compileWindowsGitStatus(source, { executable: shell }), null, source);
  }
  console.log('windows-git-status: native AST and real Git output checks passed');
} finally { rmSync(root, { recursive: true, force: true }); }
