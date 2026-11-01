import assert from 'node:assert/strict';
import { createContextReceipt, validateContextReceipt } from '../chat/context-receipt.mjs';

const complete = createContextReceipt({
  sessionId: 's1', provider: 'codex', resumeId: 'thread-1', checkpointRevision: 10,
  previousCoveredThroughSeq: 4, includedFromSeq: 5, includedThroughSeq: 10,
  eventDigest: 'sha256:events',
});
assert.equal(complete.coverage.coveredThroughSeq, 10);
assert.doesNotThrow(() => validateContextReceipt(complete));

const bound = createContextReceipt({
  sessionId: 's1', provider: 'claude', resumeId: 'session-1', checkpointRevision: 12,
  previousCoveredThroughSeq: 10, includedFromSeq: 11, includedThroughSeq: 12,
  sourceRevision: 12, workspaceRevision: 'workspace-2',
  runtimeFingerprint: 'sha256:runtime', instructionRevision: 'sha256:instructions',
  includedSourceRefs: [{ seq: 11, runId: 'run-1' }],
});
assert.equal(bound.binding.runtimeFingerprint, 'sha256:runtime');
assert.equal(bound.workspaceRevision, 'workspace-2');
assert.equal(bound.includedSourceRefs[0].seq, 11);
assert.doesNotThrow(() => validateContextReceipt(bound));

const gapped = createContextReceipt({
  sessionId: 's1', provider: 'codex', resumeId: 'thread-1', checkpointRevision: 10,
  previousCoveredThroughSeq: 4, includedFromSeq: 8, includedThroughSeq: 10,
  omittedRanges: [{ from: 5, to: 7 }],
});
assert.equal(gapped.coverage.coveredThroughSeq, 4);
assert.throws(() => validateContextReceipt({ ...gapped, coverage: { ...gapped.coverage, coveredThroughSeq: 10 } }), /crossed/);
assert.throws(() => validateContextReceipt({ ...complete, coverage: { ...complete.coverage, coveredThroughSeq: 11 } }), /exceeds checkpoint/);
console.log('test-context-receipt: ok');
