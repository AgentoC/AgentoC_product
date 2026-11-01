import assert from 'node:assert/strict';
import { sortAgyQueuedRuns } from '../lib/provider-runtime/agy-queue.mjs';

const entries = [
  { candidate: { id: 'run-c', createdAt: '2026-08-26T12:00:03.000Z', agyQueue: { queuedAt: '2026-08-26T12:00:03.000Z' } }, manifest: {} },
  { candidate: { id: 'run-a', createdAt: '2026-08-26T12:00:01.000Z', agyQueue: { queuedAt: '2026-08-26T12:00:01.000Z' } }, manifest: {} },
  { candidate: { id: 'run-b', createdAt: '2026-08-26T12:00:02.000Z', agyQueue: { queuedAt: '2026-08-26T12:00:02.000Z' } }, manifest: {} },
];

assert.deepEqual(
  sortAgyQueuedRuns(entries).map((entry) => entry.candidate.id),
  ['run-a', 'run-b', 'run-c'],
);

const tie = sortAgyQueuedRuns([
  { candidate: { id: 'run-z', createdAt: '2026-08-26T12:00:01.000Z' } },
  { candidate: { id: 'run-a', createdAt: '2026-08-26T12:00:01.000Z' } },
]);
assert.deepEqual(tie.map((entry) => entry.candidate.id), ['run-a', 'run-z']);

console.log('test-agy-queue-order: durable queuedAt FIFO ordering OK');
