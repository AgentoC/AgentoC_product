import assert from 'node:assert/strict';
import { createHarnessVersionProbeCache } from '../lib/harness-version-probe-cache.mjs';

const cache = createHarnessVersionProbeCache();
const path = '/managed/claude';
const partialGeneration = cache.generation();
cache.set(path, { version: '', error: 'native executable not extracted' }, partialGeneration);
assert.equal(cache.get(path).version, '');
cache.invalidate(); // Installer has finished; even first installs had no initial path.
assert.equal(cache.get(path), undefined);
const completedGeneration = cache.generation();
cache.set(path, { version: '2.1.310', error: '' }, completedGeneration);
// A slow background probe from the partial install completes after verification.
cache.set(path, { version: '', error: 'old probe failed' }, partialGeneration);
assert.equal(cache.get(path).version, '2.1.310');
cache.invalidate(); // Uninstall/reinstall at the same path.
cache.set(path, { version: '2.1.310', error: '' }, completedGeneration);
assert.equal(cache.get(path), undefined);
console.log('PASS: partial-install and in-flight stale version probes cannot survive managed mutation');
