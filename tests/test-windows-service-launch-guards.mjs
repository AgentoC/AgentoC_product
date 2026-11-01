// Real inbox PowerShell: no RunAs, UAC, SCM or privileged writes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canaryLaunchGuard } from '../scripts/qa-windows-service-launch-guards.mjs';
const exec = promisify(execFile);
const powershell = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
async function run(script) {
  return exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 });
}
const live = await run(`$ErrorActionPreference='Stop';${canaryLaunchGuard(Date.now()+60000)}try{throw '中文错误：测试取消'}catch{[pscustomobject]@{message=$_.Exception.Message}|ConvertTo-Json -Compress}`);
assert.equal(JSON.parse(live.stdout.trim()).message, '中文错误：测试取消');
let refused = false;
try { await run(`$ErrorActionPreference='Stop';${canaryLaunchGuard(1)}Write-Output 'BOOTSTRAP_MUST_NOT_RUN'`); }
catch (error) {
  assert.equal(error.code, 1);
  assert.match(error.stderr, /CANARY_LAUNCH_EXPIRED/);
  assert.ok(!error.stdout.includes('BOOTSTRAP_MUST_NOT_RUN'));
  refused = true;
}
assert.ok(refused);
for (const invalid of [NaN, Infinity, -1, 0, 1.5, '123']) assert.throws(() => canaryLaunchGuard(invalid));
console.log('PASS: actual PowerShell UTF-8 localized JSON, expired launch blocks bootstrap, invalid deadline refused; no elevation');
