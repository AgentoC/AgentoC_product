import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzeWindowsBash, parseLiteralBashWords } from '../chat/windows-bash-actions.mjs';
import { decideWindowsPowerShellActions } from '../chat/windows-powershell-actions.mjs';

assert.deepEqual(parseLiteralBashWords("cat '中文 文件.md'"), ['cat', '中文 文件.md']);
for (const command of ['cat x; rm -rf /', 'cat "$(rm x)"', 'cat $HOME/a', 'cat x > out', 'cat *.txt', 'cat x # comment', 'cat `whoami`']) {
  assert.equal(parseLiteralBashWords(command), null, command);
}
if (process.platform === 'win32') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentoc-bash-policy-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(path.join(workspace, 'secret', '.ssh'), { recursive: true });
  await mkdir(path.join(workspace, 'ordinary'), { recursive: true });
  await mkdir(path.join(workspace, 'linked-dest'), { recursive: true });
  await mkdir(path.join(workspace, 'existing-dest', 'ordinary', '.ssh'), { recursive: true });
  await writeFile(path.join(workspace, '中文 文件.md'), 'fixture');
  await writeFile(path.join(root, 'outside.txt'), 'fixture');
  await writeFile(path.join(workspace, 'secret', '.ssh', 'fixture-key'), 'fixture');
  await link(path.join(workspace, 'secret', '.ssh', 'fixture-key'), path.join(workspace, 'ordinary-link'));
  await link(path.join(workspace, 'secret', '.ssh', 'fixture-key'), path.join(workspace, 'linked-dest', '中文 文件.md'));
  const context = { cwd: workspace, trustedWorkspaceRoot: workspace };
  const inspect = async (command, conservative = false) => decideWindowsPowerShellActions(await analyzeWindowsBash(command, context), { conservative });
  assert.equal((await inspect("cat '中文 文件.md'")).decision, 'allow');
  for (const command of ["head -n 2 '中文 文件.md'", "tail -c10 '中文 文件.md'", "wc -lw '中文 文件.md'",
    "grep -in hello '中文 文件.md'", "grep -e hello -- '中文 文件.md'", "grep hello '中文 文件.md' > output.md", 'head ../outside.txt']) {
    assert.equal((await inspect(command)).decision, 'allow', command);
  }
  assert.equal((await inspect('head ../outside.txt', true)).decision, 'review');
  for (const command of ['tail -f ordinary', 'head -n $(whoami) ordinary', 'grep -f secret/.ssh/fixture-key ordinary',
    'grep hello secret/.ssh/fixture-key', 'wc -l secret/.ssh/fixture-key', 'grep hello ordinary > secret/.ssh/key',
    'grep --exclude-from secret/.ssh/fixture-key hello ordinary', 'grep hello']) {
    assert.equal((await inspect(command)).decision, 'review', command);
  }
  assert.equal((await inspect('ls -la')).decision, 'allow');
  assert.equal((await inspect('mkdir -p output')).decision, 'allow');
  assert.equal((await inspect('rm -rf ordinary')).decision, 'review');
  assert.equal((await inspect('rm --recursive --force ordinary')).decision, 'review');
  assert.equal((await inspect('rm -rf secret')).decision, 'review');
  assert.equal((await inspect('rm -rf /c/Windows')).decision, 'review');
  assert.equal((await inspect('cat /tmp/file')).decision, 'review');
  assert.equal((await inspect('rm -rf .')).decision, 'review');
  assert.equal((await inspect('bash -c "echo hello"')).decision, 'review');
  assert.equal((await inspect('cp -r ordinary output')).decision, 'allow');
  assert.equal((await inspect("cp '中文 文件.md' linked-dest")).decision, 'review');
  assert.equal((await inspect("mv '中文 文件.md' linked-dest")).decision, 'review');
  assert.equal((await inspect('cp -r secret output')).decision, 'review');
  assert.equal((await inspect('cp -r ordinary secret')).decision, 'allow');
  assert.equal((await inspect('cp -r ordinary existing-dest')).decision, 'review');
  assert.equal((await inspect('ls -R ordinary')).decision, 'allow');
  assert.equal((await inspect('ls --recursive secret')).decision, 'review');
  assert.equal((await inspect("echo 'hello > world' > '输出 文件.md'")).decision, 'allow');
  assert.equal((await inspect("cat '中文 文件.md' >> output.md")).decision, 'allow');
  assert.equal((await inspect('echo hello > secret/.ssh/key')).decision, 'review');
  assert.equal((await inspect('echo hello > ordinary-link')).decision, 'review');
  assert.equal((await inspect('echo hello 2> output.md')).decision, 'review');
  assert.equal((await inspect('echo hello > $HOME/file')).decision, 'review');
  assert.equal((await inspect('echo hello > one > two')).decision, 'review');
  assert.equal((await inspect("echo hello > ''")).decision, 'review');
  assert.equal((await inspect('echo hello > output.md; rm -rf /')).decision, 'review');
  await rm(root, { recursive: true, force: true });
}
console.log('windows-bash-actions: literal command and path policy checks passed');
