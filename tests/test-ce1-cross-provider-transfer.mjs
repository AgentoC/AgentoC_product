import assert from 'node:assert/strict';
import { runCe1OfflineBenchmark } from '../scripts/ce1-cross-provider-transfer.mjs';

const report = await runCe1OfflineBenchmark();
assert.equal(report.mode, 'ce1-offline-contract');
assert.equal(report.scenario.nativeResumeUsed, false);
assert.equal(report.scenario.semanticResumeUsed, true);
assert.deepEqual(report.variants.map((entry) => entry.variant), ['A', 'B', 'C']);
assert.ok(report.variants.find((entry) => entry.variant === 'C').metrics.decisionRationaleRecall);
assert.equal(report.variants.find((entry) => entry.variant === 'C').metrics.silentStaleCurrent, false);
assert.equal(report.variants.find((entry) => entry.variant === 'C').metrics.nextActionRecall, true);
assert.equal(report.acceptance.bundleNativeSessionIdLeak, false);
assert.equal(report.acceptance.bundleDigestDeterministic, true);

const second = await runCe1OfflineBenchmark();
assert.deepEqual(
  second.variants.map((entry) => ({ variant: entry.variant, metrics: entry.metrics, digest: entry.bundleDigest })),
  report.variants.map((entry) => ({ variant: entry.variant, metrics: entry.metrics, digest: entry.bundleDigest })),
  'CE-1 offline benchmark must be deterministic',
);

console.log('test-ce1-cross-provider-transfer: ok');
