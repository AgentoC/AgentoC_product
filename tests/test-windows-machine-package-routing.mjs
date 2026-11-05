import assert from 'node:assert/strict';
import { buildApprovedAction } from '../chat/approved-actions.mjs';
import { needsWindowsElevationGuidance } from '../chat/windows-elevation-guidance.mjs';

const command = 'winget install --id 7zip.7zip --exact --source winget --version 26.02 --scope machine';
const action = buildApprovedAction({ command, category: 'software_install' }, {
  platform: 'win32', sessionId: 'session-test', runId: 'run-test', turnId: 'turn-test',
  requestKey: 'request-test', cwd: 'C:\\Work', projectRoot: 'C:\\Work',
});
assert.equal(action.executionClass, 'host');
assert.equal(await needsWindowsElevationGuidance(command, 'PowerShell'), true);
assert.equal(await needsWindowsElevationGuidance('winget install --id example.package --scope user', 'PowerShell'), false);
console.log('Windows machine package routing: ok');
