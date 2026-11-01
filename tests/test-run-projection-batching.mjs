#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRunProjectionService } from '../chat/run-projection.mjs';

const records = Array.from({ length: 40 }, (_, index) => ({
  recordId: `record-${index}`,
  stream: 'stdout',
  line: JSON.stringify({ type: 'message', id: `event-${index}`, content: `message ${index}` }),
  ts: '2026-09-06T00:00:00.000Z',
}));
const delivered = [];

const service = createRunProjectionService({
  buildCodexContextMetricsPayload: () => null,
  clipPreview: (value) => String(value).slice(0, 120),
  createToolInvocation: async () => ({
    provider: 'test',
    runtimeFamily: 'test-json',
    capabilities: [],
    adapter: {
      parseLine(line) {
        const value = JSON.parse(line);
        return [{ type: value.type, id: value.id, content: value.content }];
      },
      flush() { return []; },
    },
  }),
  materializeRunSpoolLine: async (_runId, record) => record.line,
  normalizeRunEvents: (_run, events) => events,
  readLatestCodexSessionMetrics: async () => null,
  readRunSpoolDelta: async () => ({ records: [], nextOffset: 0, processedLineCount: 0, skippedLineCount: 0 }),
  readRunSpoolRecords: async () => records,
  streamRunSpoolRecords: async function* () { yield* records; },
  scanRunSpoolRecords: async () => [],
});

const result = await service.collectNormalizedRunEvents({
  id: 'projection-batch-run',
  sessionId: 'projection-batch-session',
  runtimeFamily: 'test-json',
}, {
  tool: 'test',
  options: {},
}, {
  onNormalizedEvents: async (batch) => delivered.push(batch.map((event) => event.id)),
});

assert.equal(result.normalizedEventCount, 40);
assert.deepEqual(delivered.map((batch) => batch.length), [32, 8]);
assert.deepEqual(delivered.flat(), records.map((_, index) => `event-${index}`));
assert.equal(result.normalizedEvents[0].harnessEventId, 'spool:record-0:0');
assert.equal(result.normalizedEvents[0].harnessEventSource, 'spool-record');

console.log('test-run-projection-batching: ok');
