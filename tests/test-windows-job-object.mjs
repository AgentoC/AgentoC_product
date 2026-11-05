import assert from 'node:assert/strict';
import {
  isWindowsJobObjectSupported,
  normalizeWindowsEnvironment,
  resolveWindowsJobHostPaths,
} from '../lib/windows-job-object.mjs';

assert.equal(isWindowsJobObjectSupported('win32'), true);
assert.equal(isWindowsJobObjectSupported('linux'), false);
assert.deepEqual(resolveWindowsJobHostPaths({ SystemRoot: 'D:\\WinNT' }), {
  cmd: 'D:\\WinNT\\System32\\cmd.exe', root: 'D:\\WinNT',
});
assert.deepEqual(resolveWindowsJobHostPaths({ WINDIR: 'E:\\Windows' }), {
  cmd: 'E:\\Windows\\System32\\cmd.exe', root: 'E:\\Windows',
});
assert.equal(resolveWindowsJobHostPaths({ SystemRoot: 'relative' }), null);

const normalized = normalizeWindowsEnvironment({
  Path: 'lower-priority-path',
  PATH: 'canonical-path',
  NODE_ENV: 'test',
  OMIT_ME: null,
});
assert.deepEqual(normalized, {
  PATH: 'canonical-path',
  NODE_ENV: 'test',
});
assert.deepEqual(normalizeWindowsEnvironment({ path: 'lower-only-path', OTHER: 42 }), {
  PATH: 'lower-only-path',
  OTHER: '42',
});
assert.equal(normalizeWindowsEnvironment({ Path: undefined }), undefined);
assert.throws(
  () => normalizeWindowsEnvironment({ 'BAD\0KEY': 'value' }),
  /invalid key/,
);
assert.throws(
  () => normalizeWindowsEnvironment({ BAD_VALUE: 'bad\0value' }),
  /NUL in BAD_VALUE/,
);

console.log('test-windows-job-object: 7 passed, 0 failed');
