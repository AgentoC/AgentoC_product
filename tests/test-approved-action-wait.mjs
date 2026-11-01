import assert from 'node:assert/strict';

import { waitForApprovedActionResolution } from '../chat/approved-action-wait.mjs';

const runs = [
  {
    id: 'run_waiting',
    approvedActionPending: { batchId: 'batch_waiting' },
    actionPause: { kind: 'approved_action', state: 'waiting_user' },
  },
  {
    id: 'run_resolved',
  },
];
let reads = 0;
let sleeps = 0;
const resolved = await waitForApprovedActionResolution('run_waiting', {
  getRunImpl: async () => {
    reads += 1;
    return runs[reads - 1] || runs.at(-1);
  },
  sleepImpl: async () => {
    sleeps += 1;
  },
  pollIntervalMs: 1,
});
assert.equal(resolved.id, 'run_resolved');
assert.equal(reads, 2);
assert.equal(sleeps, 1);

const cancelled = await waitForApprovedActionResolution('run_cancelled', {
  getRunImpl: async () => ({ cancelRequested: true }),
  sleepImpl: async () => { throw new Error('cancelled run must not sleep'); },
});
assert.equal(cancelled.cancelRequested, true);

let transientReads = 0;
let transientSleeps = 0;
const recovered = await waitForApprovedActionResolution('run_recovering', {
  getRunImpl: async () => {
    transientReads += 1;
    if (transientReads === 1) throw new Error('storage temporarily unavailable');
    return { id: 'run_recovered' };
  },
  sleepImpl: async () => {
    transientSleeps += 1;
  },
});
assert.equal(recovered.id, 'run_recovered');
assert.equal(transientReads, 2);
assert.equal(transientSleeps, 1);

console.log('test-approved-action-wait: ok');
