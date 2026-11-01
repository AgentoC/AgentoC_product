#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRunProjectionService } from '../chat/run-projection.mjs';
import {
  filterUnknownHarnessEvents,
  getProviderEventReplayKey,
} from '../chat/provider-event-dedup.mjs';

const record = {
  recordId: 'record-replayed-after-restart',
  stream: 'stdout',
  ts: '2026-09-09T00:00:00.000Z',
  line: JSON.stringify({ type: 'assistant', content: 'No upstream identity.' }),
};
const run = {
  id: 'run-spool-replay',
  sessionId: 'session-spool-replay',
  runtimeFamily: 'test-json',
};
const manifest = { tool: 'test', options: {} };

function makeProjectionService() {
  return createRunProjectionService({
    buildCodexContextMetricsPayload: () => null,
    clipPreview: (value) => String(value || ''),
    createToolInvocation: async () => ({
      provider: 'test',
      runtimeFamily: 'test-json',
      capabilities: [],
      adapter: {
        parseLine(line) {
          const value = JSON.parse(line);
          return [{ type: 'message', role: 'assistant', content: value.content }];
        },
        flush() { return []; },
      },
    }),
    materializeRunSpoolLine: async (_runId, spoolRecord) => spoolRecord.line,
    normalizeRunEvents: (projectionRun, events) => events.map((event) => ({
      ...event,
      runId: projectionRun.id,
    })),
    readLatestCodexSessionMetrics: async () => null,
    readRunSpoolDelta: async () => ({ records: [], nextOffset: 0, processedLineCount: 0, skippedLineCount: 0 }),
    readRunSpoolRecords: async () => [record],
    streamRunSpoolRecords: async function* () { yield record; },
    scanRunSpoolRecords: async () => [],
  });
}

// A fresh service simulates a server restart: it reparses the same durable
// spool record with a new adapter, yet the projected harness identity remains
// stable and can be dropped against the event history from the first pass.
const firstProjection = await makeProjectionService().collectNormalizedRunEvents(run, manifest);
const replayProjection = await makeProjectionService().collectNormalizedRunEvents(run, manifest);
assert.equal(firstProjection.normalizedEvents[0].harnessEventId, 'spool:record-replayed-after-restart:0');
assert.equal(replayProjection.normalizedEvents[0].harnessEventId, firstProjection.normalizedEvents[0].harnessEventId);

const knownKeys = new Set(firstProjection.normalizedEvents.map(getProviderEventReplayKey).filter(Boolean));
assert.deepEqual(
  filterUnknownHarnessEvents(replayProjection.normalizedEvents, knownKeys),
  [],
  'replaying the same spool record after restart must not append a second history event',
);

console.log('test-run-projection-spool-replay-dedup: ok');
