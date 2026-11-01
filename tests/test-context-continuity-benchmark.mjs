import assert from 'node:assert/strict';
import { runContextContinuityBenchmark } from '../scripts/benchmark-context-continuity.mjs';

const report = await runContextContinuityBenchmark();
assert.equal(report.mode, 'deterministic-offline-replay');
assert.ok(report.fixture.turns >= 10);
assert.ok(report.fixture.eventCount >= 40);
assert.equal(report.verification.continuityReplay.restartReplay, 'passed');
assert.equal(report.verification.continuityReplay.staleCheckpointCas, 'passed');
assert.equal(report.verification.largeToolResultRawReference.present, true);
assert.equal(report.verification.pendingApprovalProjection, 'pending');
assert.equal(report.verification.workspaceDriftProjection, true);
assert.equal(report.pendingApprovalPlan.mandatory, true);
assert.equal(report.embeddings, 'No - keep deterministic recall for now.');

const byVariant = (variant) => report.variants.filter((entry) => entry.variant === variant);
assert.equal(byVariant('A').length, 3);
assert.equal(byVariant('B').length, 3);
assert.equal(byVariant('C').length, 3);
assert.equal(report.comparisons.length, 3);
assert.ok(report.handoffBehaviorMetrics.manualReviewRequired.repeatedFileReads.startsWith('not-measured:'));
for (const entry of byVariant('A')) {
  assert.equal(entry.metrics.contextPlanApplied, false);
  assert.ok(entry.metrics.shadowSelectedItems > 0);
  assert.equal(entry.metrics.staleFactSilentlyTreatedAsCurrent, true);
}
for (const entry of byVariant('B')) {
  assert.equal(entry.metrics.contextPlanApplied, true);
  assert.equal(entry.metadata.contextCompilerMode, 'compatibility');
  assert.equal(entry.metrics.coverage, 1);
  assert.equal(entry.metrics.staleFactCount, 1);
  assert.equal(entry.metrics.staleFactWarningSelected, true);
  assert.equal(entry.metrics.staleFactWarningCarried, true);
  assert.equal(entry.metrics.staleFactSilentlyTreatedAsCurrent, false);
}
for (const entry of byVariant('C')) {
  assert.equal(entry.metrics.contextPlanApplied, true);
  assert.equal(entry.metrics.coverage, 1);
  assert.match(entry.metadata.providerCompiler, /-context-compiler-v1$/);
}

const second = await runContextContinuityBenchmark();
assert.deepEqual(
  second.variants.map((entry) => ({
    variant: entry.variant,
    runtimeFamily: entry.runtimeFamily,
    metrics: entry.metrics,
    digest: entry.plan.receipt.contentDigest,
  })),
  report.variants.map((entry) => ({
    variant: entry.variant,
    runtimeFamily: entry.runtimeFamily,
    metrics: entry.metrics,
    digest: entry.plan.receipt.contentDigest,
  })),
  'replay benchmark should be deterministic',
);

console.log('test-context-continuity-benchmark: ok');
