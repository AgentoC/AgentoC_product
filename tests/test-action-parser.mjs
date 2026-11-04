import assert from 'node:assert/strict';
import { parseProviderAction, parseShellCommand } from '../chat/action-parser.mjs';
import { inferShellKind, parseCmdCommand, parsePowerShellCommand } from '../chat/action-parser-platform.mjs';
import { classifyProviderOperation } from '../chat/provider-operation-classifier.mjs';
import { buildOperationProjection } from '../chat/operation-projection.mjs';

assert.equal(parseShellCommand('cat src/package.json', { executionPlatform: 'linux' }).semanticKind, 'read');
assert.equal(parseShellCommand('cat src/package.json', { executionPlatform: 'linux' }).subject, 'package.json');
assert.equal(parseShellCommand('ls src', { executionPlatform: 'linux' }).semanticKind, 'list');
assert.deepEqual(parseShellCommand('rg "timeout" src', { executionPlatform: 'linux' }).subject, 'timeout in src');
assert.equal(parseShellCommand('git status --short', { executionPlatform: 'linux' }).semanticKind, 'inspect');
assert.equal(parseShellCommand('bash -lc "rg foo src"', { executionPlatform: 'linux' }).semanticKind, 'search');
assert.equal(parseShellCommand('npm test', { executionPlatform: 'linux' }).semanticKind, 'execute');
assert.equal(parseShellCommand('cat package.json && ls src', { executionPlatform: 'linux' }).composite, true);

assert.equal(inferShellKind({ executionPlatform: 'win32' }), 'powershell');
assert.equal(inferShellKind({ executionPlatform: 'win32', command: 'dir src' }), 'cmd');
assert.equal(parsePowerShellCommand('rg timeout src').subject, 'timeout in src');
assert.equal(parsePowerShellCommand('git status --short').subject, 'workspace status');
assert.equal(parsePowerShellCommand('npm test').subject, 'npm test');
assert.equal(parseCmdCommand('npm test').subject, 'npm test');
assert.equal(parsePowerShellCommand('tool --token secret').subject, 'tool --token [redacted]');
assert.equal(parsePowerShellCommand('Get-Content C:\\workspace\\package.json').semanticKind, 'read');
assert.equal(parsePowerShellCommand('Get-Content C:\\workspace\\package.json').subject, 'package.json');
assert.equal(parsePowerShellCommand('Get-ChildItem C:\\workspace\\src').semanticKind, 'list');
assert.equal(parsePowerShellCommand('Select-String -Pattern timeout -Path src').semanticKind, 'search');
assert.equal(parseCmdCommand('type C:\\workspace\\package.json').semanticKind, 'read');
assert.equal(parseCmdCommand('dir C:\\workspace\\src').semanticKind, 'list');
assert.equal(parseCmdCommand('findstr timeout src\\*.js').semanticKind, 'search');
assert.equal(parseCmdCommand('cmd.exe /c "dir src"').semanticKind, 'list');
assert.equal(parsePowerShellCommand('Get-ChildItem src | Select-String timeout').groupable, false);

const structured = parseProviderAction({
  providerActions: [{ type: 'search', query: 'timeout', path: 'src' }],
});
assert.equal(structured.semanticKind, 'search');
assert.equal(structured.subject, 'timeout in src');

const classified = classifyProviderOperation({
  operationKind: 'command',
  toolName: 'bash',
  executionPlatform: 'linux',
  toolInput: JSON.stringify({ command: 'git status --short', cwd: '/tmp/project' }),
});
assert.equal(classified.action.semanticKind, 'inspect');
assert.equal(classified.action.subject, 'workspace status');

const windowsClassified = classifyProviderOperation({
  operationKind: 'command',
  toolName: 'powershell',
  executionPlatform: 'win32',
  shellKind: 'powershell-5.1',
  command: 'Get-ChildItem C:\\workspace\\src',
});
assert.equal(windowsClassified.action.semanticKind, 'list');
assert.equal(windowsClassified.shellKind, 'powershell-5.1');

const projection = buildOperationProjection([
  { type: 'tool_use', seq: 1, runId: 'run-1', providerToolUseId: 'a', toolName: 'bash', executionPlatform: 'linux', toolInput: 'cat a.txt', operationKind: 'command', operationLifecycle: 'started' },
  { type: 'tool_result', seq: 2, runId: 'run-1', providerToolUseId: 'a', toolName: 'bash', executionPlatform: 'linux', toolInput: 'cat a.txt', operationKind: 'command', operationLifecycle: 'completed', exitCode: 0 },
  { type: 'tool_use', seq: 3, runId: 'run-1', providerToolUseId: 'b', toolName: 'bash', executionPlatform: 'linux', toolInput: 'rg foo src', operationKind: 'command', operationLifecycle: 'started' },
]);
assert.equal(projection.operations[0].presentation.labelKind, 'read');
assert.equal(projection.operations[0].presentation.subject, 'a.txt');
assert.equal(projection.operations[1].presentation.labelKind, 'search');
assert.equal(projection.operations[1].presentation.group.kind, 'exploring');
assert.equal(projection.operations[0].presentation.group.count, 2);

console.log('test-action-parser: ok');
