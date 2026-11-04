import assert from 'node:assert/strict';
import { decodeCodexShlexArgv, decideWindowsApproval, readWindowsPowerShellInvocation } from '../chat/windows-approval-gate.mjs';
import { resolveWindowsSystemPaths } from '../chat/windows-system-paths.mjs';

const systemRoot = process.platform === 'win32' ? resolveWindowsSystemPaths()?.root : 'C:\\Windows';
assert.ok(systemRoot, 'Windows system root must be available');
const executable = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const standardRoots = { systemRoot, programFiles: 'C:\\Program Files' };
const command = { approvalId: 'command-1', kind: 'command', params: {
  command: [executable, '-NoProfile', '-Command', 'Get-Content readme.txt'],
} };
assert.equal(readWindowsPowerShellInvocation(command, standardRoots).command, 'Get-Content readme.txt');
const otherRoot = 'D:\\WinOS';
const otherExecutable = `${otherRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
assert.equal(readWindowsPowerShellInvocation({ ...command, params: { command: [otherExecutable, '-NoProfile', '-Command', 'Get-Date'] } }, { systemRoot: otherRoot, programFiles: 'E:\\Apps' }).executable, otherExecutable);
assert.equal(readWindowsPowerShellInvocation(command, { systemRoot: '', programFiles: '' }), null);
{
  const originalRoot = process.env.SystemRoot, originalWindir = process.env.WINDIR;
  try {
    delete process.env.SystemRoot; process.env.WINDIR = otherRoot;
    assert.equal(readWindowsPowerShellInvocation({ ...command, params: { command: [otherExecutable, '-NoProfile', '-Command', 'Get-Date'] } }).executable, otherExecutable);
  } finally {
    if (originalRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = originalRoot;
    if (originalWindir === undefined) delete process.env.WINDIR; else process.env.WINDIR = originalWindir;
  }
}
assert.equal(readWindowsPowerShellInvocation({ ...command, params: { command: ['C:\\other\\powershell.exe', '-NoProfile', '-Command', 'Get-Date'] } }), null);
assert.equal(readWindowsPowerShellInvocation({ ...command, params: { command: [executable, '-Command', 'Get-Date'] } }), null);
assert.equal(readWindowsPowerShellInvocation({ ...command, params: { command: 'Get-Date', shellKind: 'powershell' } }), null);
assert.equal(readWindowsPowerShellInvocation({ ...command, params: { tool_name: 'Bash', input: { command: 'Get-Date' } } }), null);
assert.deepEqual(decodeCodexShlexArgv("'C:\\Windows\\test.exe' -NoProfile -Command 'Write-Output '\"'\"'hello'\"'\"''"), ['C:\\Windows\\test.exe', '-NoProfile', '-Command', "Write-Output 'hello'"]);
assert.equal(decodeCodexShlexArgv('powershell -Command foo;evil'), null);
assert.equal(decodeCodexShlexArgv("powershell 'unterminated"), null);
const state = { cwd: 'C:\\work', riskContext: { platform: 'win32', trustedWorkspaceRoot: 'C:\\work' } };
const safe = async () => ({ complete: true, actions: [{ kind: 'write', workspace: true, target: { lexical: 'C:\\work\\a', actual: 'C:\\work\\a' } }] });
const unknown = async () => ({ complete: false, actions: [], reason: 'unresolved expression' });
for (const riskMode of ['recommended', 'full-auto']) {
  assert.equal((await decideWindowsApproval(command, { ...state, riskMode }, { analyze: safe })).decision, 'auto-allow');
  assert.equal((await decideWindowsApproval(command, { ...state, riskMode }, { analyze: unknown })).decision, 'prompt');
}
assert.equal((await decideWindowsApproval(command, { ...state, riskMode: 'conservative-auto' }, { analyze: async () => ({ complete: true, actions: [{ kind: 'write', workspace: false, target: {} }] }) })).decision, 'prompt');
const write = { approvalId: 'file-1', kind: 'permissions', params: { tool_name: 'Write', input: { file_path: 'C:\\work\\a' } } };
assert.equal((await decideWindowsApproval(write, { ...state, riskMode: 'full-auto' }, { analyzeFiles: safe })).decision, 'auto-allow');
const missingChanges = { approvalId: 'file-2', kind: 'file_change', providerMethod: 'item/fileChange/requestApproval', params: { changes: [{ path: 'C:\\work\\a' }] } };
assert.equal((await decideWindowsApproval(missingChanges, state)).decision, 'prompt');
const observed = { ...missingChanges, params: { itemId: 'item-1' } };
const observedState = { ...state, activeItems: new Map([['item-1', { type: 'fileChange', changes: [{ path: 'C:\\work\\a', kind: { type: 'update' } }] }]]) };
assert.equal((await decideWindowsApproval(observed, observedState, { analyzeFiles: safe })).decision, 'auto-allow');
assert.equal((await decideWindowsApproval(observed, { ...state, activeItems: new Map([['item-1', { type: 'commandExecution', changes: [{ path: 'C:\\work\\a', kind: { type: 'update' } }] }]]) }, { analyzeFiles: safe })).decision, 'prompt');
assert.equal((await decideWindowsApproval({ ...observed, params: { ...observed.params, grantRoot: 'C:\\work' } }, observedState, { analyzeFiles: safe })).decision, 'prompt');
let moveEntries;
const moveState = { ...state, activeItems: new Map([['item-1', { type: 'fileChange', changes: [{ path: 'C:\\work\\a', kind: { type: 'update', move_path: 'C:\\other\\b' } }] }]]) };
await decideWindowsApproval(observed, moveState, { analyzeFiles: async (entries) => { moveEntries = entries; return safe(); } });
assert.deepEqual(moveEntries.map((entry) => entry.kind), ['delete', 'write']);
assert.equal((await decideWindowsApproval(command, { ...state, riskContextValid: false })).decision, 'prompt');
for (const extra of [
  { networkApprovalContext: { host: 'example.com', protocol: 'https' } },
  { additionalPermissions: { network: { enabled: true } } },
]) {
  assert.equal((await decideWindowsApproval({ ...command, params: { ...command.params, ...extra } }, state, { analyze: safe })).decision, 'prompt');
}
if (process.platform === 'win32') {
  const wrapped = { approvalId: 'wrapped', kind: 'command', params: { command: `& '${executable}' -NoProfile -Command 'Get-Content readme.txt'` } };
  assert.equal((await decideWindowsApproval(wrapped, { ...state, riskMode: 'full-auto' }, { analyze: safe })).decision, 'auto-allow');
  const serialized = { ...wrapped, providerMethod: 'item/commandExecution/requestApproval', params: { command: `'${executable}' -NoProfile -Command 'Get-Content readme.txt'` } };
  assert.equal((await decideWindowsApproval(serialized, { ...state, riskMode: 'full-auto' }, { analyze: safe })).decision, 'auto-allow');
  const fake = { ...serialized, params: { command: `'C:\\untrusted\\powershell.exe' -NoProfile -Command 'Get-Date'` } };
  assert.equal((await decideWindowsApproval(fake, state, { analyze: safe })).decision, 'prompt');
}
console.log('windows-approval-gate: shared decision and harness boundary checks passed');
