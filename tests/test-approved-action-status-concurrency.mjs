import assert from 'node:assert/strict';
import { createKeyedTaskQueue } from '../chat/fs-utils.mjs';
import { dispatchApprovedActionProposal } from '../chat/approved-action-queue.mjs';

const queue = createKeyedTaskQueue();
let release;
const waiting = new Promise(resolve => { release = resolve; });
let writes = 0, checks = 0;
const execute = async input => {
  if (input.token !== 'valid') throw new Error('unauthorized');
  if (input.autoInstallStatusOnly) { checks++; return 'status'; }
  writes++;
  await waiting;
  return 'submitted';
};
const base = { runId: 'run', requestKey: 'same', token: 'valid' };
const first = dispatchApprovedActionProposal(base, { queue, execute });
await Promise.resolve();
const second = dispatchApprovedActionProposal(base, { queue, execute });
const status = await dispatchApprovedActionProposal({ ...base, autoInstallStatusOnly: true }, { queue, execute });
assert.equal(status, 'status');
assert.equal(checks, 1);
assert.equal(writes, 1, 'second mutation must remain serialized');
await assert.rejects(dispatchApprovedActionProposal({ ...base, token: 'invalid', autoInstallStatusOnly: true }, { queue, execute }), /unauthorized/);
release();
assert.equal(await first, 'submitted');
assert.equal(await second, 'submitted');
assert.equal(writes, 2);
console.log('approved-action-status-concurrency: ok');
