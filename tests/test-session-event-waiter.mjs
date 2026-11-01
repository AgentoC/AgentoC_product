#!/usr/bin/env node
import assert from 'assert/strict';

const {
  waitForSessionEvents,
  notifySessionEvents,
  __getSessionEventWaiterCountForTest,
  __getTotalSessionEventWaitersForTest,
} = await import('../chat/session-event-waiter.mjs');

let sequence = 0;
function sessionId(label) {
  sequence += 1;
  return `event-waiter-${label}-${process.pid}-${sequence}`;
}

{
  const id = sessionId('notify');
  let reads = 0;
  const pending = waitForSessionEvents(id, {
    timeoutMs: 500,
    readEvents: async () => {
      reads += 1;
      return reads === 1 ? { events: [] } : { events: [{ seq: 4 }], latestSeq: 4 };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(__getSessionEventWaiterCountForTest(id), 1);
  assert.equal(notifySessionEvents(id, 4), 1);
  const result = await pending;
  assert.equal(result.notified, true);
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.result.events, [{ seq: 4 }]);
  assert.equal(__getSessionEventWaiterCountForTest(id), 0);
}

{
  const id = sessionId('race');
  let reads = 0;
  const result = await waitForSessionEvents(id, {
    timeoutMs: 500,
    readEvents: async () => {
      reads += 1;
      if (reads === 1) {
        notifySessionEvents(id, 7);
        return { events: [] };
      }
      return { events: [{ seq: 7 }], latestSeq: 7 };
    },
  });
  assert.equal(result.notified, true, 'a notification during the initial read must be retained');
  assert.deepEqual(result.result.events, [{ seq: 7 }]);
  assert.equal(__getSessionEventWaiterCountForTest(id), 0);
}

{
  const id = sessionId('timeout');
  const result = await waitForSessionEvents(id, {
    timeoutMs: 10,
    readEvents: async () => ({ events: [], latestSeq: 2 }),
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.notified, false);
  assert.deepEqual(result.result.events, []);
  assert.equal(__getSessionEventWaiterCountForTest(id), 0);
}

{
  const id = sessionId('abort');
  const controller = new AbortController();
  const pending = waitForSessionEvents(id, {
    timeoutMs: 500,
    readEvents: async () => ({ events: [] }),
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  const result = await pending;
  assert.equal(result.aborted, true);
  assert.equal(__getSessionEventWaiterCountForTest(id), 0);
}

assert.equal(__getTotalSessionEventWaitersForTest(), 0);
console.log('test-session-event-waiter: ok');
