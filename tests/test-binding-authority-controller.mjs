import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBindingAuthorityController } from '../lib/binding-authority-controller.mjs';
import { createBindingAuthorityCarrierLifecycle } from '../chat/binding-authority-carriers.mjs';

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(initial = null) {
  let retained = structuredClone(initial), wall = 1_800_000_000_000, mono = 0, writesFail = false, queryImpl;
  const timers = new Set(), events = [], writes = [], queries = [];
  const scope = { instanceId: 'inst_controller', keyFingerprint: 'a'.repeat(64) };
  function receipt(revision = '7', state = 'active', accountId = 'acct_controller') {
    return { ...scope, accountId, revision, state, authorityProtocol: 1, checkedAt: wall, expiresAt: wall + 30_000 };
  }
  queryImpl = async ({ accountId }) => receipt('7', 'active', accountId);
  const options = { ...scope, readState: async () => structuredClone(retained),
    writeState: async next => { if (writesFail) throw Error('synthetic disk failure'); retained = structuredClone(next); writes.push(next); },
    query: async input => { queries.push(input); return queryImpl(input); }, clock: () => wall, monotonicNow: () => mono,
    onInvalidate: event => events.push(event),
    setTimer: (fn, delay) => { const timer = { fn, at: mono + delay, unref() {} }; timers.add(timer); return timer; },
    clearTimer: timer => timers.delete(timer) };
  return { scope, options, controller: createBindingAuthorityController(options), receipt, timers, events, writes, queries,
    completion: revision => ({ ...scope, accountId: 'acct_controller', revision }),
    request: revision => ({ accountId: 'acct_controller', revision }),
    query: fn => { queryImpl = fn; }, failWrites: value => { writesFail = value; },
    retained: () => structuredClone(retained),
    advance: (elapsed, wallDelta = elapsed) => {
      mono += elapsed; wall += wallDelta;
      for (const timer of [...timers]) if (timer.at <= mono) { timers.delete(timer); timer.fn(); }
    } };
}

test('concurrent remote authorization shares one verified query and never changes generation', async () => {
  const f = fixture(), gate = deferred(); f.query(() => gate.promise);
  let committed = false;
  await f.controller.acceptVerifiedCompletion(f.completion('7'), async () => { assert.equal(f.retained().revision, '7'); committed = true; });
  assert(committed);
  const requests = Array.from({ length: 20 }, () => f.controller.authorize(f.request('7')));
  await new Promise(setImmediate); assert.equal(f.queries.length, 1);
  gate.resolve(f.receipt());
  assert.equal((await Promise.all(requests)).length, 20);
  assert(f.controller.allows('acct_controller', '7')); assert.equal(f.queries.length, 1);
  await assert.rejects(f.controller.authorize(f.request('6')), { code: 'owner_auth_authority_superseded' });
  await assert.rejects(f.controller.authorize(f.request('')), { code: 'owner_auth_authority_upgrade_required' });
  f.controller.stop();
});

test('rate-limited authority refresh respects retry-after without extending an existing proof', async () => {
  const f = fixture(); await f.controller.acceptVerifiedCompletion(f.completion('7'));
  await f.controller.authorize(f.request('7'));
  f.advance(10_000);
  f.query(async () => { throw Object.assign(new Error('rate limited'), { statusCode: 429, retryAfterMs: 25_000 }); });
  await assert.rejects(f.controller.refresh('acct_controller'), { statusCode: 429 });
  const calls = f.queries.length;
  for (let n = 0; n < 10; n++) await assert.rejects(f.controller.refresh('acct_controller'), { statusCode: 429 });
  assert.equal(f.queries.length, calls, 'cooldown must not issue more rate-limited requests');
  assert.equal(f.controller.allows('acct_controller', '7'), true);
  f.advance(20_001);
  assert.equal(f.controller.allows('acct_controller', '7'), false, 'cooldown must not extend authority');
  await assert.rejects(f.controller.authorize(f.request('7')), { statusCode: 429 });
  f.advance(5_000); f.query(async () => f.receipt());
  assert.equal((await f.controller.authorize(f.request('7'))).revision, '7');
  assert.equal(f.queries.length, calls + 1);
  f.controller.stop();
});

test('revocation survives restart and a same-generation active reply cannot resurrect it', async () => {
  const f = fixture(); await f.controller.acceptVerifiedCompletion(f.completion('7'));
  await f.controller.authorize(f.request('7'));
  f.query(async () => f.receipt('8', 'revoked')); await f.controller.refresh('acct_controller');
  assert.equal(f.controller.allows('acct_controller', '7'), false);
  assert.deepEqual(f.retained().deniedAccounts, ['acct_controller']);
  f.controller.stop();
  const restarted = createBindingAuthorityController(f.options);
  await assert.rejects(restarted.acceptVerifiedCompletion(f.completion('7')), { code: 'owner_auth_authority_superseded' });
  await assert.rejects(restarted.acceptVerifiedCompletion(f.completion('8')), { code: 'owner_auth_authority_superseded' });
  f.query(async () => f.receipt('8', 'active'));
  assert.equal((await restarted.refresh('acct_controller')).active, false);
  f.query(async () => f.receipt('9', 'active'));
  await restarted.acceptVerifiedCompletion(f.completion('9'));
  assert.equal((await restarted.authorize(f.request('9'))).revision, '9');
  await assert.rejects(restarted.authorize(f.request('7')), { code: 'owner_auth_authority_superseded' });
  restarted.stop();
});

test('late old status cannot overwrite a newly accepted binding', async () => {
  const f = fixture(), gate = deferred();
  await f.controller.acceptVerifiedCompletion(f.completion('7')); f.query(() => gate.promise);
  const old = f.controller.refresh('acct_controller'); await new Promise(setImmediate);
  await f.controller.acceptVerifiedCompletion(f.completion('9'));
  gate.resolve(f.receipt('7'));
  await assert.rejects(old, { code: 'owner_auth_authority_superseded' });
  assert.equal(f.retained().revision, '9'); assert.equal(f.controller.allows('acct_controller', '7'), false);
  f.query(async () => f.receipt('9')); await f.controller.authorize(f.request('9'));
  f.controller.stop();
});

test('hard expiry interrupts authority while a refresh is stalled, even with a backwards wall clock', async () => {
  const f = fixture(); await f.controller.acceptVerifiedCompletion(f.completion('7'));
  await f.controller.authorize(f.request('7'));
  f.advance(10_000); const gate = deferred(); const original = f.receipt('7'); f.query(() => gate.promise);
  const refresh = f.controller.refresh('acct_controller'); await new Promise(setImmediate);
  f.advance(20_001, -1000);
  assert.equal(f.controller.allows('acct_controller', '7'), false);
  assert(f.events.some(e => e.reason === 'authority-expired'));
  assert.equal(f.timers.size, 0); assert.equal(f.retained().revision, '7');
  f.advance(10_000, 30_000); gate.resolve(original);
  await assert.rejects(refresh, { code: 'owner_auth_authority_assertion_invalid' });
  f.query(async () => f.receipt('7')); await f.controller.authorize(f.request('7'));
  assert(f.controller.allows('acct_controller', '7')); f.controller.stop();
});

test('verified inactive reconciliation persists denial and closes access before awaiting cleanup', async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  const c = createBindingAuthorityController({ ...f.options, onVerifiedInactive: async receipt => {
    assert.equal(receipt.state, 'revoked'); assert.equal(f.retained().revision, '8');
    assert.deepEqual(f.retained().deniedAccounts, ['acct_controller']);
    assert.equal(c.allows('acct_controller', '7'), false); entered.resolve(); await gate.promise;
  } });
  await c.acceptVerifiedCompletion(f.completion('7')); await c.authorize(f.request('7'));
  f.query(async () => f.receipt('8', 'revoked'));
  const revoked = c.refresh('acct_controller'); await entered.promise;
  let published = false;
  const completion = c.acceptVerifiedCompletion(f.completion('9'), () => { published = true; });
  await new Promise(setImmediate); assert.equal(published, false);
  gate.resolve(); await revoked; await completion; assert.equal(published, true);
  assert.equal(f.retained().revision, '9'); c.stop(); f.controller.stop();
});

test('late signed inactive response cannot clean a newer completed binding', async () => {
  const f = fixture(), gate = deferred(), cleaned = [];
  const c = createBindingAuthorityController({ ...f.options, onVerifiedInactive: receipt => cleaned.push(receipt) });
  await c.acceptVerifiedCompletion(f.completion('7')); f.query(() => gate.promise);
  const old = c.refresh('acct_controller'); await new Promise(setImmediate);
  await c.acceptVerifiedCompletion(f.completion('9')); gate.resolve(f.receipt('8', 'revoked'));
  await assert.rejects(old, { code: 'owner_auth_authority_superseded' });
  assert.equal(cleaned.length, 0); assert.equal(f.retained().revision, '9'); c.stop(); f.controller.stop();
});

test('mismatch, transport failure, invalid proof and persistence failure never reconcile metadata', async () => {
  const f = fixture(), cleaned = [];
  const c = createBindingAuthorityController({ ...f.options, onVerifiedInactive: receipt => cleaned.push(receipt) });
  await c.acceptVerifiedCompletion(f.completion('7'));
  f.query(async () => f.receipt('7', 'mismatch')); await c.refresh('acct_controller');
  f.query(async () => { throw Error('synthetic transport failure'); }); await assert.rejects(c.refresh('acct_controller'));
  f.query(async () => ({ ...f.receipt('8', 'revoked'), keyFingerprint: 'b'.repeat(64) }));
  await assert.rejects(c.refresh('acct_controller'), { code: 'owner_auth_authority_assertion_invalid' });
  f.query(async () => ({ ...f.receipt('8', 'revoked'), expiresAt: f.receipt().checkedAt }));
  await assert.rejects(c.refresh('acct_controller'), { code: 'owner_auth_authority_assertion_invalid' });
  f.query(async () => f.receipt('8', 'revoked')); f.failWrites(true);
  await assert.rejects(c.refresh('acct_controller'), { code: 'owner_auth_authority_persistence_failed' });
  assert.equal(cleaned.length, 0); f.failWrites(false);
  f.query(async () => f.receipt('8', 'missing')); await c.refresh('acct_controller');
  assert.equal(cleaned.length, 1); assert.equal(cleaned[0].state, 'missing'); c.stop(); f.controller.stop();
});

test('cleanup failure retains durable revocation and a fresh signed retry can reconcile', async () => {
  const f = fixture(); let fail = true, attempts = 0;
  const c = createBindingAuthorityController({ ...f.options, onVerifiedInactive: async () => {
    attempts++; if (fail) throw Error('synthetic metadata write failure');
  } });
  await c.acceptVerifiedCompletion(f.completion('7')); await c.authorize(f.request('7'));
  f.query(async () => f.receipt('8', 'revoked')); await assert.rejects(c.refresh('acct_controller'));
  assert.equal(c.allows('acct_controller', '7'), false); assert.equal(f.retained().revision, '8');
  fail = false; await c.refresh('acct_controller'); assert.equal(attempts, 2);
  await assert.rejects(c.acceptVerifiedCompletion(f.completion('8')), { code: 'owner_auth_authority_superseded' });
  c.stop(); f.controller.stop();
});

test('a disk failure denies access and keeps the observed higher revision in memory', async () => {
  const f = fixture(); await f.controller.acceptVerifiedCompletion(f.completion('7')); await f.controller.authorize(f.request('7'));
  f.failWrites(true); let published = false;
  await assert.rejects(f.controller.acceptVerifiedCompletion(f.completion('9'), () => { published = true; }),
    { code: 'owner_auth_authority_persistence_failed' });
  assert.equal(published, false); assert.equal(f.retained().revision, '7'); assert.equal(f.controller.allows('acct_controller', '7'), false);
  f.query(async () => f.receipt('7')); await assert.rejects(f.controller.refresh('acct_controller'), { code: 'owner_auth_authority_superseded' });
  f.failWrites(false); f.query(async () => f.receipt('9'));
  await f.controller.authorize(f.request('9')); assert.equal(f.retained().revision, '9'); f.controller.stop();
});

test('serialized binding publication prevents an old completion overwriting a newer one', async () => {
  const f = fixture(), gate = deferred(); const published = [];
  const first = f.controller.acceptVerifiedCompletion(f.completion('7'), async () => { await gate.promise; published.push('7'); });
  const newer = f.controller.acceptVerifiedCompletion(f.completion('9'), () => published.push('9'));
  const old = f.controller.acceptVerifiedCompletion(f.completion('8'), () => published.push('8'));
  gate.resolve(); await Promise.all([first, newer]);
  await assert.rejects(old, { code: 'owner_auth_authority_superseded' });
  assert.deepEqual(published, ['7', '9']); assert.equal(f.retained().revision, '9'); f.controller.stop();
});

test('a different-account mismatch does not discard current-account proof at the same revision', async () => {
  const f = fixture(); await f.controller.acceptVerifiedCompletion(f.completion('7')); await f.controller.authorize(f.request('7'));
  f.query(async ({ accountId }) => f.receipt('7', 'mismatch', accountId)); await f.controller.refresh('acct_old_owner');
  assert.deepEqual(f.retained().deniedAccounts, ['acct_old_owner']); assert(f.controller.allows('acct_controller', '7'));
  f.controller.stop();
});

test('corrupt, ambiguous or differently scoped persistent state never becomes empty state', async () => {
  const base = fixture();
  for (const value of [undefined, {}, { version: 1, ...base.scope, revision: '01', deniedAccounts: [] },
    { version: 1, ...base.scope, revision: '7', deniedAccounts: ['duplicate', 'duplicate'] },
    { version: 1, ...base.scope, keyFingerprint: 'b'.repeat(64), revision: '7', deniedAccounts: [] }]) {
    const f = fixture(); const c = createBindingAuthorityController({ ...f.options, readState: async () => value });
    await assert.rejects(c.initialize(), { code: 'owner_auth_authority_state_invalid' }); assert.equal(f.writes.length, 0); c.stop();
  }
});

test('stop fences an in-flight response and clears the independent expiry timer', async () => {
  const f = fixture(), gate = deferred(); await f.controller.acceptVerifiedCompletion(f.completion('7'));
  f.query(() => gate.promise); const refresh = f.controller.refresh('acct_controller'); await new Promise(setImmediate);
  f.controller.stop(); gate.resolve(f.receipt()); await assert.rejects(refresh, { code: 'owner_auth_authority_stopped' });
  assert.equal(f.timers.size, 0); assert.equal(f.controller.allows('acct_controller', '7'), false);
});

test('carrier closure finishes before recovery and a local device revoke stops only that device', async () => {
  let observer; const calls = [], gate = deferred();
  const lifecycle = createBindingAuthorityCarrierLifecycle({ subscribe: fn => { observer = fn; return () => {}; },
    closeClients: event => calls.push(event?.deviceId ? `close:${event.deviceId}` : 'close'),
    stopHosts: async () => { calls.push('stop'); await gate.promise; calls.push('stopped'); },
    stopDevice: id => calls.push(`stop:${id}`), restoreHosts: () => calls.push('restore') });
  observer({ type: 'invalidated', appliesToCurrentAccount: true }); observer({ type: 'active' });
  await new Promise(setImmediate); assert.deepEqual(calls, ['close', 'stop']);
  gate.resolve(); await lifecycle.drain(); await new Promise(setImmediate);
  assert.deepEqual(calls, ['close', 'stop', 'stopped', 'restore']);
  observer({ type: 'device-invalidated', deviceId: 'phone-1' });
  assert.deepEqual(calls.slice(-2), ['close:phone-1', 'stop:phone-1']); await lifecycle.dispose();
});

test('a carrier stop failure is handled and prevents recovery until a later successful close', async () => {
  let observer, fail = true; const errors = [], restored = [];
  const lifecycle = createBindingAuthorityCarrierLifecycle({ subscribe: fn => { observer = fn; return () => {}; },
    closeClients: () => {}, stopHosts: async () => { if (fail) throw Error('synthetic carrier stop failure'); },
    restoreHosts: () => restored.push(true), onError: error => errors.push(error.message) });
  observer({ type: 'invalidated', appliesToCurrentAccount: true });
  await assert.rejects(lifecycle.drain()); observer({ type: 'active' }); await new Promise(setImmediate);
  assert(errors.length > 0); assert.equal(restored.length, 0);
  fail = false; observer({ type: 'invalidated', appliesToCurrentAccount: true }); observer({ type: 'active' });
  await lifecycle.drain(); await new Promise(setImmediate); assert.equal(restored.length, 1); await lifecycle.dispose();
});
