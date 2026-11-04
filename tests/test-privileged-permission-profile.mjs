#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolvePrivilegedBatchPolicy, deferWindowsLegacyInstallBatch } from '../chat/privileged-permission-profile.mjs';
import { openPrivilegedBatchApproval, resolvePrivilegedCategoryApproval } from '../chat/privileged-approval.mjs';
import { CATEGORY_OTHER } from '../chat/privileged-classifier.mjs';

const denyAll = { install: 'deny', other: 'deny', delete: 'deny' };
const manual = { install: 'execute', other: 'wait_owner', delete: 'wait_owner' };
assert.deepEqual(resolvePrivilegedBatchPolicy('full-auto', 'win32'), denyAll);
assert.deepEqual(resolvePrivilegedBatchPolicy('full-auto', 'linux'), {
  install: 'execute', other: 'deny', delete: 'deny',
});
assert.deepEqual(resolvePrivilegedBatchPolicy('full-auto', 'darwin'), {
  install: 'execute', other: 'deny', delete: 'deny',
});
for (const platform of ['win32', 'linux', 'darwin']) {
  assert.deepEqual(resolvePrivilegedBatchPolicy('conservative-auto', platform), denyAll);
  assert.deepEqual(resolvePrivilegedBatchPolicy('recommended', platform), manual);
}
const legacy = { batchId: 'batch', installAuto: [{ opId: 'install-1', command: 'winget install Vendor.App' }], other: [{ opId: 'other-1' }], delete: [] };
const windows = deferWindowsLegacyInstallBatch(legacy, 'win32');
assert.deepEqual(windows.installAuto, []);
assert.deepEqual(windows.other.map((op) => op.opId), ['other-1', 'install-1']);
assert.equal(windows.other[1].deferredFromInstall, true);
assert.equal(legacy.installAuto.length, 1, 'stored input is not mutated');
assert.equal(deferWindowsLegacyInstallBatch(legacy, 'linux'), legacy);
assert.equal(resolvePrivilegedBatchPolicy('recommended', 'win32').other, 'wait_owner');
assert.equal(resolvePrivilegedBatchPolicy('full-auto', 'win32').other, 'deny');
const events = [];
const store = { readEvents: async () => events, appendEvent: async (event) => { events.push(event); return event; } };
const opened = await openPrivilegedBatchApproval(windows, store);
assert.deepEqual(opened.requestEvent.installAuto, [], 'Android must not hide this as an automatic-only installation');
assert.equal(opened.requestEvent.other.find((op) => op.opId === 'install-1')?.deferredFromInstall, true);
const reviewed = await resolvePrivilegedCategoryApproval({ batchId: legacy.batchId, category: CATEGORY_OTHER, checkedOpIds: ['install-1'] }, store);
assert.deepEqual(reviewed.approved.map((op) => op.opId), ['install-1']);
assert.deepEqual(reviewed.denied.map((op) => op.opId), ['other-1']);

console.log('test-privileged-permission-profile: ok');
