#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const realtimeSource = readFileSync(join(repoRoot, 'static/chat/realtime.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const paramsStart = source.indexOf('(', start);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

assert.match(realtimeSource, /WS_RECONNECT_BASE_DELAY_MS = 1_000/);
assert.match(realtimeSource, /WS_RECONNECT_MAX_DELAY_MS = 30_000/);
assert.match(realtimeSource, /WS_RECONNECT_JITTER_RATIO/);
assert.match(realtimeSource, /navigator\.onLine === false/);

const scheduleSource = extractFunctionSource(realtimeSource, 'scheduleReconnect');
const scheduled = [];
const context = {
  navigator: { onLine: true },
  reconnectTimer: null,
  reconnectAttempt: 0,
  WS_RECONNECT_BASE_DELAY_MS: 1_000,
  WS_RECONNECT_MAX_DELAY_MS: 30_000,
  WS_RECONNECT_JITTER_RATIO: 0.2,
  isNetworkOffline: () => context.navigator.onLine === false,
  Math: {
    min: Math.min,
    round: Math.round,
    random: () => 0.5,
  },
  setTimeout(callback, delayMs) {
    const timer = { callback, delayMs };
    scheduled.push(timer);
    return timer;
  },
  clearTimeout(timer) {
    timer.cancelled = true;
  },
  connect() {},
  maybeActivateP2P() {},
};
context.globalThis = context;
vm.runInNewContext(`${scheduleSource}\nglobalThis.scheduleReconnect = scheduleReconnect;`, context, {
  filename: 'static/chat/realtime.js',
});

context.scheduleReconnect();
assert.equal(scheduled.length, 1, 'first disconnect should schedule one reconnect');
assert.equal(scheduled[0].delayMs, 1_000, 'first retry should start at the base delay');
assert.equal(context.reconnectAttempt, 1, 'first retry should advance the backoff attempt');

context.scheduleReconnect();
assert.equal(scheduled.length, 1, 'a pending retry must not be duplicated');

context.reconnectTimer = null;
scheduled[0].callback();
context.scheduleReconnect();
assert.equal(scheduled.length, 2, 'a later disconnect should schedule the next retry');
assert.equal(scheduled[1].delayMs, 2_000, 'second retry should use exponential backoff');

context.reconnectTimer = null;
context.navigator.onLine = false;
context.scheduleReconnect();
assert.equal(scheduled.length, 2, 'offline browsers must pause reconnect attempts');

console.log('test-chat-ws-reconnect-backoff: ok');
