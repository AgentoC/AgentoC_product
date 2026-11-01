import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRendezvousResultWaiters, rendezvousResultWaitMs,
  waitForRendezvousResultTick } from '../accounts/rendezvous-result-waiters.mjs';

test('wait budget is opt-in and accepts only bounded integers', () => {
  assert.equal(rendezvousResultWaitMs(undefined),0);
  assert.equal(rendezvousResultWaitMs(0),0);
  assert.equal(rendezvousResultWaitMs(10_000),10_000);
  for (const value of [null, '1000', -1, 0.5, 10_001, NaN, Infinity]) {
    assert.throws(() => rendezvousResultWaitMs(value), { code: 'owner_auth_rendezvous_wait_invalid' });
  }
});

test('notification is target-specific and leaves no retained subscriber', async () => {
  const hub = createRendezvousResultWaiters();
  const one = hub.subscribe({ requestId: 'one', subjectId: 'phone', timeoutMs: 100 });
  const two = hub.subscribe({ requestId: 'two', subjectId: 'phone', timeoutMs: 100 });
  hub.notify('one');
  assert.deepEqual(await one.promise, { kind: 'notified' });
  assert.equal(two.pending,true);
  two.cancel();two.cancel();
  assert.deepEqual(await two.promise, { kind: 'cancelled' });
  assert.deepEqual(hub.stats(), { total:0, subjects:0, requests:0 });
});

test('timeout releases all admission counters', async () => {
  const hub=createRendezvousResultWaiters();
  const wait=hub.subscribe({ requestId:'one',subjectId:'phone',timeoutMs:10 });
  assert.deepEqual(await wait.promise,{kind:'timeout'});
  assert.equal(hub.stats().total,0);
});

test('cancelled and already aborted requests cannot leak capacity', async () => {
  const hub=createRendezvousResultWaiters(),controller=new AbortController(),reason=new Error('stopped');
  const wait=hub.subscribe({requestId:'one',subjectId:'phone',timeoutMs:100,signal:controller.signal});
  controller.abort(reason);
  const result=await wait.promise;
  assert.equal(result.kind,'aborted');assert.equal(result.reason,reason);
  assert.throws(()=>hub.subscribe({requestId:'one',subjectId:'phone',timeoutMs:100,signal:controller.signal}),e=>e===reason);
  assert.equal(hub.stats().total,0);
});

for (const [name,options,first,second] of [
  ['global',{maximumWaiters:1},['one','a'],['two','b']],
  ['phone',{maximumPerSubject:1},['one','a'],['two','a']],
  ['request',{maximumPerRequest:1},['one','a'],['one','b']],
]) {
  test(`${name} capacity refuses another waiter without evicting the first`, async()=>{
    const hub=createRendezvousResultWaiters(options);
    const wait=hub.subscribe({requestId:first[0],subjectId:first[1],timeoutMs:100});
    assert.throws(()=>hub.subscribe({requestId:second[0],subjectId:second[1],timeoutMs:100}),{statusCode:429});
    assert.equal(wait.pending,true);hub.close();await wait.promise;assert.equal(hub.stats().total,0);
  });
}

test('checkpoint does not remove the subscriber or create a lost-notification gap', async()=>{
  const hub=createRendezvousResultWaiters(),wait=hub.subscribe({requestId:'one',subjectId:'a',timeoutMs:100});
  assert.deepEqual(await waitForRendezvousResultTick(wait,5),{kind:'checkpoint'});
  assert.equal(wait.pending,true);hub.notify('one');
  assert.deepEqual(await waitForRendezvousResultTick(wait,50),{kind:'notified'});
  assert.equal(hub.stats().total,0);
});

test('shutdown resolves outstanding requests and refuses future wait admission', async()=>{
  const hub=createRendezvousResultWaiters(),wait=hub.subscribe({requestId:'one',subjectId:'a',timeoutMs:100});
  hub.close();hub.close();assert.deepEqual(await wait.promise,{kind:'closed'});
  assert.throws(()=>hub.subscribe({requestId:'two',subjectId:'b',timeoutMs:100}),{statusCode:503});
  assert.equal(hub.stats().total,0);
});
