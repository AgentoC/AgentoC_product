import assert from 'node:assert/strict';
import { buildWindowsCliReadBridge } from '../chat/windows-cli-read-bridge.mjs';

if (process.platform !== 'win32') { console.log('windows-cli-read-bridge: skipped (requires Windows)'); process.exit(0); }
const state = { turnActive: true, riskContextValid: true, sessionControlReadAvailable: true, riskMode: 'recommended',
  windowsManagedActionChannel: true, windowsManagedActionBinding: { runId: 'fixture-run' } };
const helperPath = 'C:\\Program Files\\AgentoC\\bin\\agentoc-cli-read-bridge.exe';
const inspect = async () => ({ isFile: () => true, isSymbolicLink: () => false });
const request = command => ({ providerMethod: 'can_use_tool', params: { tool_name: 'PowerShell', input: { command } } });
const bridge = (command, overrides = {}) => buildWindowsCliReadBridge({ approval: request(command), state, helperPath, port: 7690, runId: 'fixture-run', ...overrides }, { inspect });
for (const riskMode of ['recommended', 'full-auto']) {
  const result = await bridge('agentoc trigger list --json 2>&1 | Out-String', { state: { ...state, riskMode } });
  assert.equal(result?.updatedCommand, "& 'C:\\Program Files\\AgentoC\\bin\\agentoc-cli-read-bridge.exe' trigger-list 'http://127.0.0.1:7690' --json");
}
assert.ok(await bridge('agentoc trigger list'));
for (const command of [
  'agentoc trigger delete x', 'agentoc trigger list --base-url http://attacker',
  'agentoc trigger list --json; Remove-Item secret', 'agentoc trigger list --json > output.txt',
  'agentoc trigger list --json | Out-String; Write-Output extra',
  'agentoc trigger list --json | Out-String -Stream', 'agentoc trigger list $env:EVIL',
  'agentoc trigger list --json | Out-String > output.txt',
  'agentoc trigger list --json; Out-String', 'agentoc trigger list --json 2>&1 3>&1',
  'agentoc trigger list --json --json', 'agentoc trigger list --session other',
]) assert.equal(await bridge(command), null, command);
assert.equal(await bridge('agentoc trigger list', { state: { ...state, riskMode: 'conservative-auto' } }), null);
assert.equal(await bridge('agentoc trigger list', { state: { ...state, turnActive: false } }), null);
assert.equal(await bridge('agentoc trigger list', { state: { ...state, sessionControlReadAvailable: false } }), null);
assert.equal(await bridge('agentoc trigger list', { runId: 'different-run' }), null);
assert.equal(await bridge('agentoc trigger list', { state: { ...state, interactionMode: 'plan' } }), null);
assert.equal(await bridge('agentoc trigger list', { port: 0 }), null);
const privileged = request('agentoc trigger list'); privileged.params.additionalPermissions = { network: true };
assert.equal(await buildWindowsCliReadBridge({ approval: privileged, state, helperPath, port: 7690, runId: 'fixture-run' }, { inspect }), null);
console.log('windows-cli-read-bridge: native AST and policy boundary checks passed');
