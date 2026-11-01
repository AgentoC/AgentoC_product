import assert from 'node:assert/strict';
import {
  buildToolResultDescriptors,
  createToolResultDescriptor,
  readToolResultRange,
} from '../chat/tool-result-descriptor.mjs';

const largeOutput = `${'build output line\n'.repeat(70_000)}final failure: test_case_17`;
const descriptor = createToolResultDescriptor({
  type: 'tool_result',
  id: 'evt_tool_1',
  seq: 17,
  runId: 'run-1',
  toolExecutionId: 'tool-1',
  toolName: 'npm test',
  command: 'npm test -- --runInBand',
  output: largeOutput,
  exitCode: 1,
  bodyRef: 'evt_000000017_output',
  bodyBytes: Buffer.byteLength(largeOutput, 'utf8'),
  artifacts: [{ assetId: 'asset-report', name: 'report.txt', mimeType: 'text/plain' }],
});

assert.equal(descriptor.outcome, 'failed');
assert.equal(descriptor.toolExecutionId, 'tool-1');
assert.equal(descriptor.rawOutputRef.kind, 'history_body');
assert.equal(descriptor.rawOutputRef.ref, 'evt_000000017_output');
assert.equal(descriptor.preview.truncated, true);
assert.ok(descriptor.preview.text.length <= 2400);
assert.equal(descriptor.artifacts[0].assetId, 'asset-report');
assert.match(descriptor.commandDigest, /^sha256:/);
assert.equal(descriptor.outputBytes, Buffer.byteLength(largeOutput, 'utf8'));

const deferredDescriptor = createToolResultDescriptor({
  type: 'tool_result',
  id: 'evt-deferred',
  seq: 18,
  toolName: 'npm test',
  bodyRef: 'evt_000000018_output',
  bodyPreview: 'preview only',
  bodyAvailable: true,
});
assert.equal(deferredDescriptor.outputSha256, undefined, 'index previews must not masquerade as raw output digests');
assert.equal(deferredDescriptor.rawOutputRef.seq, 18);

const descriptors = buildToolResultDescriptors([
  { type: 'message', role: 'user', content: 'ignored' },
  { type: 'tool_result', id: 'evt-2', toolName: 'git diff', output: 'clean', exitCode: 0 },
]);
assert.equal(descriptors.length, 1);
assert.equal(descriptors[0].outcome, 'succeeded');

const range = await readToolResultRange({
  descriptor: { ...descriptor, outputSha256: descriptor.outputSha256 },
  readRaw: async () => largeOutput,
  startByte: 0,
  endByte: 64,
  maxBytes: 64,
});
assert.equal(range.text, largeOutput.slice(0, 64));
assert.equal(range.endByte, 64);
assert.equal(range.truncated, true);
await assert.rejects(
  () => readToolResultRange({
    descriptor: { ...descriptor, outputSha256: 'sha256:wrong' },
    readRaw: async () => largeOutput,
  }),
  (error) => error.code === 'TOOL_RESULT_RAW_DIGEST_MISMATCH',
);

console.log('test-tool-result-descriptor: ok');
