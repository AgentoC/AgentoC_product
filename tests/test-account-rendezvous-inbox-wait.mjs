import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inboxWaitFixture } from './fixtures/rendezvous-inbox-wait.mjs';

async function until(condition) {
  const deadline = performance.now() + 1000;
  while (!condition()) {
    assert(performance.now() < deadline, 'Fixture wait deadline');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
const poll = (f, waitMs, signal) => f.broker.pollAccountRendezvousInbox(f.proof(waitMs), { signal });
const close = f => (f.broker.closeRendezvousInboxWaiters || f.broker.closeRendezvousResultWaiters)();

test('legacy inbox remains immediate, bound wait times out honestly, unknown keys cannot occupy wait slots', async () => {
  const f = await inboxWaitFixture();
  try {
    assert.deepEqual(await poll(f), { intent: null, grant: null });
    const started = performance.now(), result = await poll(f, 25);
    assert(performance.now() - started >= 20); assert.equal(result.inboxWaitVersion, 1);
    f.state.instanceBindings = [];
    assert.deepEqual(await poll(f, 10000), { intent: null, grant: null });
    await assert.rejects(f.broker.pollAccountRendezvousInbox({ ...f.proof(10),
      instance: { ...f.instance, keyFingerprint: 'a'.repeat(64) } }), { statusCode: 401 });
  } finally { close(f); }
});

test('only committed signed authorization wakes the exact instance inbox', async () => {
  const f = await inboxWaitFixture();
  try {
    const offer = await f.prepareOffer();
    const pending = poll(f, 1000); await until(() => f.reads >= 2);
    let commit; const gate = new Promise(resolve => { commit = resolve; });
    f.hooks.beforeCommit = () => gate;
    let settled = false; pending.then(() => { settled = true; });
    const authorization = f.broker.authorizeAccountJoinIntent(offer.authorization, f.credential);
    await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(settled, false);
    commit(); await authorization;
    assert.equal((await pending).intent.intentId, offer.intent.intentId);
  } finally { close(f); }
});

test('a grant committed between first read and waiter subscription is not lost', async () => {
  const f = await inboxWaitFixture();
  try {
    const offer = await f.prepareOffer();
    f.hooks.afterRead = count => count === 1 ? f.broker.authorizeAccountJoinIntent(offer.authorization, f.credential) : null;
    const started = performance.now();
    assert.equal((await poll(f, 1000)).intent.intentId, offer.intent.intentId);
    assert(performance.now() - started < 500);
  } finally { close(f); }
});

test('cross-process grant publication is found by a fresh checkpoint without waiting the full deadline', async () => {
  const f = await inboxWaitFixture(), second = f.makeBroker();
  try {
    const offer = await f.prepareOffer(), started = performance.now();
    const pending = poll(f, 5000); await until(() => f.reads >= 2);
    await second.authorizeAccountJoinIntent(offer.authorization, f.credential);
    assert.equal((await pending).intent.intentId, offer.intent.intentId);
    assert(performance.now() - started < 3500);
  } finally { close(f); (second.closeRendezvousInboxWaiters || second.closeRendezvousResultWaiters)(); }
});

test('notification during a read forces a new committed snapshot before delivery', async () => {
  const f = await inboxWaitFixture();
  try {
    const offer = await f.prepareOffer();
    f.hooks.afterRead = count => count === 2 ? f.broker.authorizeAccountJoinIntent(offer.authorization, f.credential) : null;
    const result = await poll(f, 1000);
    assert.equal(result.intent.intentId, offer.intent.intentId);
    assert.equal(f.reads, 3);
  } finally { close(f); }
});

test('binding revoked or rekeyed while waiting never returns an older snapshot', async () => {
  for (const field of ['revokedAt', 'boundAt', 'instanceKeyFingerprint']) {
    const f = await inboxWaitFixture();
    try {
      f.hooks.afterRead = count => { if (count === 2) f.state.instanceBindings[0][field] = 'changed'; };
      await assert.rejects(poll(f, 25), { statusCode: 403 });
    } finally { close(f); }
  }
});

test('bounded wait admission, abort, invalid duration and shutdown release capacity', async () => {
  const f = await inboxWaitFixture(), a = new AbortController(), b = new AbortController();
  try {
    const first = poll(f, 10000, a.signal), second = poll(f, 10000, b.signal);
    first.catch(() => {}); second.catch(() => {}); await until(() => f.reads >= 4);
    await assert.rejects(poll(f, 10000), { statusCode: 429 });
    a.abort(); b.abort();
    await assert.rejects(first, { name: 'AbortError' }); await assert.rejects(second, { name: 'AbortError' });
    for (const duration of [-1, 10001, 0.5, '1000']) await assert.rejects(poll(f, duration), { statusCode: 400 });
    assert.equal((await poll(f, 10)).intent, null);
    const before = f.reads, pending = poll(f, 10000); await until(() => f.reads >= before + 2); close(f);
    assert.equal((await pending).intent, null);
  } finally { a.abort(); b.abort(); close(f); }
});
