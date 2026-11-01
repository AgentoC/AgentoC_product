#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolvePrivilegedBatchPolicy } from '../chat/privileged-permission-profile.mjs';

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

console.log('test-privileged-permission-profile: ok');
