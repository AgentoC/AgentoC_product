import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const source = await readFile(new URL('../chat-server.mjs', import.meta.url), 'utf8');

function harness(loadModule) {
  // Execute the real entrypoint's promise chain and synchronous shutdown phase.
  // Replace only dynamic module loading; do not listen, read credentials or start
  // the rest of the server to test lifecycle ownership.
  const startup = source.match(/void import\('\.\/chat\/account-pairing-service\.mjs'\)[\s\S]*?\.catch\([^\n]*\);/);
  assert.ok(startup, 'The listening server must actually start the account pairing poller');
  const shutdownStart = source.indexOf('async function shutdown(');
  const shutdownEnd = source.indexOf('  shutdownPromise = (async () => {', shutdownStart);
  assert.ok(shutdownStart >= 0 && shutdownEnd > shutdownStart);
  const warnings = [];
  const context = vm.createContext({
    loadModule, console: { warn: (...args) => warnings.push(args) },
    shutdownPromise: null, shuttingDown: false,
    ownerService: null, ownerActivation: null,
    startupRecoveryTimer: null, rendezvousPollTimer: null,
    stopTemporaryPairingPoller() {},
    stopTemporaryControlPoller() {},
    clearTimeout,
  });
  vm.runInContext('let stopAccountPairingPoller = () => {};\n'
    + source.slice(shutdownStart, shutdownEnd) + '\n}\n', context);
  const startupScript = startup[0].replace("import('./chat/account-pairing-service.mjs')", 'loadModule()');
  vm.runInContext(startupScript, context);
  return { context, warnings, shutdown: () => vm.runInContext('shutdown("fixture")', context) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('listening entrypoint starts one account poller and shutdown stops it', async () => {
  let starts = 0, stops = 0;
  const app = harness(async () => ({ startAccountPairingPoller: async () => {
    starts++; return () => stops++;
  } }));
  await tick();
  assert.equal(starts, 1);
  assert.equal(stops, 0);
  await app.shutdown();
  assert.equal(stops, 1);
  assert.deepEqual(app.warnings, []);
});

test('a poller completing startup after shutdown is immediately stopped', async () => {
  let resolveStart, stops = 0;
  const app = harness(async () => ({ startAccountPairingPoller: () =>
    new Promise((resolve) => { resolveStart = resolve; }) }));
  await tick();
  assert.equal(typeof resolveStart, 'function');
  await app.shutdown();
  resolveStart(() => stops++);
  await tick();
  assert.equal(stops, 1, 'late startup must not leave a live background poller');
});

test('module startup failure uses a fixed diagnostic without leaking failure text', async () => {
  const app = harness(async () => { throw new Error('synthetic-private-upstream-text'); });
  await tick();
  assert.equal(app.warnings.length, 1);
  assert.deepEqual(app.warnings[0], ['[account-pairing] deferred poller start failed']);
  await app.shutdown();
});
