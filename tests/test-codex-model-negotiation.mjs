import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createCodexAccountModelCatalog, selectCodexAccountDefaultModel } from '../chat/codex-app-server-default-model.mjs';

function fixture(t, overrides = {}) {
  const requests = [], selected = [], failures = [];
  let next = 1000;
  const catalog = createCodexAccountModelCatalog({
    nextRequestId: () => next++,
    sendRequest: (request) => { requests.push(request); return true; },
    beforeReady: async () => {},
    onReady: (model) => { selected.push(model); },
    onFailure: async (error) => { failures.push(error); },
    ...overrides,
  });
  t.after(() => catalog.cancel());
  const reply = (data, extra = {}) => catalog.consume({ id: requests.at(-1).id, result: { data, ...extra } });
  return { catalog, requests, selected, failures, reply };
}

test('later-page live default wins; hidden models and unrelated RPCs do not select', async (t) => {
  const f = fixture(t);
  assert.equal(f.catalog.start(), true);
  assert.equal(await f.catalog.consume({ id: 'other', result: { data: [] } }), false);
  await f.reply([{ id: 'first' }, { id: 'hidden', hidden: true, isDefault: true }], { nextCursor: 'second' });
  assert.deepEqual(f.selected, []);
  assert.equal(f.requests[1].cursor, 'second');
  assert.notEqual(f.requests[0].id, f.requests[1].id);
  await f.reply([{ id: 'opaque-id', model: 'account-default', isDefault: true }]);
  assert.deepEqual(f.selected, ['account-default']);
  assert.equal(f.catalog.start(), false);
  assert.equal(await f.reply([{ id: 'late-default', isDefault: true }]), true);
  assert.deepEqual(f.selected, ['account-default']);
});

test('duplicate model preserves a later default marker', async (t) => {
  const f = fixture(t); f.catalog.start();
  await f.reply([{ id: 'first' }, { id: 'default' }], { nextCursor: 'next' });
  await f.reply([{ id: 'default', isDefault: true }]);
  assert.deepEqual(f.selected, ['default']);
});

test('a late earlier-page error stays owned and cannot fail the next page', async (t) => {
  const f = fixture(t); f.catalog.start();
  const oldId = f.requests[0].id;
  await f.reply([{ id: 'first' }], { nextCursor: 'next' });
  assert.equal(await f.catalog.consume({ id: oldId, error: { message: 'late earlier error' } }), true);
  assert.deepEqual(f.failures, []);
  await f.reply([{ id: 'current', isDefault: true }]);
  assert.deepEqual(f.selected, ['current']);
});

test('default absence preserves first visible account model', async (t) => {
  const f = fixture(t); f.catalog.start();
  await f.reply([{ id: 'hidden', hidden: true }, { id: 'first' }, { id: 'second' }]);
  assert.deepEqual(f.selected, ['first']);
});

test('empty catalog fails without selecting stale config', async (t) => {
  const f = fixture(t); f.catalog.start(); await f.reply([]);
  assert.deepEqual(f.selected, []);
  assert.equal(f.failures[0].code, 'CODEX_ACCOUNT_MODEL_CATALOG_EMPTY');
});

test('malformed catalog fails without fallback', async (t) => {
  const f = fixture(t); f.catalog.start(); await f.reply('not-an-array');
  assert.equal(f.failures[0].code, 'CODEX_ACCOUNT_MODEL_CATALOG_INVALID');
  assert.deepEqual(f.selected, []);
});

test('RPC error retains a safe code without upstream body', async (t) => {
  const f = fixture(t); f.catalog.start();
  await f.catalog.consume({ id: f.requests[0].id, error: { message: 'private upstream detail' } });
  assert.equal(f.failures[0].code, 'CODEX_ACCOUNT_MODEL_CATALOG_UNAVAILABLE');
  assert.doesNotMatch(f.failures[0].message, /private upstream detail/);
});

test('repeated pagination cursor fails once', async (t) => {
  const f = fixture(t); f.catalog.start();
  await f.reply([{ id: 'first' }], { nextCursor: 'loop' });
  await f.reply([{ id: 'second' }], { nextCursor: 'loop' });
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].code, 'CODEX_ACCOUNT_MODEL_CATALOG_INVALID');
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.selected, []);
});

test('page limit refuses partial selection', async (t) => {
  const f = fixture(t, { maxPages: 1 }); f.catalog.start();
  await f.reply([{ id: 'first' }], { nextCursor: 'more' });
  assert.equal(f.requests.length, 1);
  assert.equal(f.failures[0].code, 'CODEX_ACCOUNT_MODEL_CATALOG_LIMIT');
  assert.deepEqual(f.selected, []);
});

test('entry limit includes hidden and duplicate rows', async (t) => {
  const f = fixture(t, { maxEntries: 2 }); f.catalog.start();
  await f.reply([{ id: 'same' }, { id: 'same' }, { id: 'hidden', hidden: true }]);
  assert.equal(f.failures[0].code, 'CODEX_ACCOUNT_MODEL_CATALOG_LIMIT');
});

test('serialized catalog response is bounded', async (t) => {
  const f = fixture(t, { maxResponseBytes: 100 }); f.catalog.start();
  await f.reply([{ id: 'large', description: 'x'.repeat(200) }]);
  assert.equal(f.failures[0].code, 'CODEX_ACCOUNT_MODEL_CATALOG_LIMIT');
});

test('invalid cursor type refuses further queries', async (t) => {
  const f = fixture(t); f.catalog.start(); await f.reply([{ id: 'first' }], { nextCursor: 123 });
  assert.equal(f.failures[0].code, 'CODEX_ACCOUNT_MODEL_CATALOG_INVALID');
});

test('closed stdin fails immediately', async (t) => {
  const f = fixture(t, { sendRequest: () => false });
  assert.equal(f.catalog.start(), false);
  assert.equal(f.failures[0].code, 'CODEX_STDIN_CLOSED');
});

test('authorization refusal after catalog wait preserves its original error', async (t) => {
  const denied = Object.assign(new Error('Run inputs unavailable'), { code: 'RUN_EXECUTION_INPUT_UNAVAILABLE' });
  const f = fixture(t, { beforeReady: async () => { throw denied; } });
  f.catalog.start(); await f.reply([{ id: 'current', isDefault: true }]);
  assert.equal(f.failures[0], denied);
  assert.deepEqual(f.selected, []);
});

test('cancellation before a late reply cannot publish a model', async (t) => {
  const f = fixture(t); f.catalog.start(); f.catalog.cancel();
  assert.equal(await f.reply([{ id: 'current' }]), true);
  assert.deepEqual(f.selected, []);
  assert.deepEqual(f.failures, []);
});

test('cancellation while authorization awaits cannot start a thread later', async (t) => {
  let release;
  const f = fixture(t, { beforeReady: () => new Promise((resolve) => { release = resolve; }) });
  f.catalog.start(); const pending = f.reply([{ id: 'current' }]);
  assert.equal(typeof release, 'function');
  f.catalog.cancel(); release(); await pending;
  assert.deepEqual(f.selected, []);
});

test('silent catalog timeout fails once and ignores a late result', async (t) => {
  const f = fixture(t, { timeoutMs: 20 }); f.catalog.start(); await delay(60);
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].code, 'CODEX_ACCOUNT_MODEL_CATALOG_TIMEOUT');
  assert.equal(await f.reply([{ id: 'late' }]), true);
  assert.equal(await f.catalog.consume({ id: f.requests[0].id, error: { message: 'late crash' } }), true);
  assert.equal(f.failures.length, 1);
  assert.deepEqual(f.selected, []);
});

test('timeout during authorization wait cannot publish after a late success', async (t) => {
  let release;
  const f = fixture(t, { timeoutMs: 20, beforeReady: () => new Promise((resolve) => { release = resolve; }) });
  f.catalog.start(); const pending = f.reply([{ id: 'current' }]);
  await delay(60); release(); await pending;
  assert.equal(f.failures[0].code, 'CODEX_ACCOUNT_MODEL_CATALOG_TIMEOUT');
  assert.deepEqual(f.selected, []);
});

test('malformed or hidden default rows cannot override a valid visible model', () => {
  assert.equal(selectCodexAccountDefaultModel([
    { id: 123, isDefault: true }, { id: 'hidden', hidden: true, isDefault: true }, { id: ' valid ' },
  ]), 'valid');
});
