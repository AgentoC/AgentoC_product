#!/usr/bin/env node
// broker-fetch 传输层加固的契约测试：瞬断重试、每尝试超时、5xx 重试、
// 4xx/未知错误不重试、调用方中止直通，以及 TURN broker 客户端的重试语义。
// 背景：云端 accounts/TURN 链路经代理路由存在间歇性瞬断，单次 fetch 失败
// 会把手机 Connect 卡死在 connecting（2026-09-06 事故根因）。
import assert from 'assert/strict';
import {
  fetchBrokerJsonWithRetry,
  isTransientBrokerFetchError,
  nextBrokerBackoffMs,
} from '../lib/broker-fetch.mjs';
import { requestTurnCredentials } from '../lib/turn-credential-broker-client.mjs';

let passed = 0;
function assertEq(actual, expected, label) {
  assert.deepStrictEqual(actual, expected, label);
  passed += 1;
}

const noSleep = () => Promise.resolve();

function transientError(code = 'ECONNRESET') {
  return Object.assign(new TypeError('fetch failed'), { cause: { code } });
}

function brokerBody(connectionId = 'conn-1') {
  return {
    protocolVersion: 1,
    provider: 'cloudflare-realtime',
    transport: 'turn',
    appTrafficOnly: true,
    credentialScope: 'device-access',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    iceServers: [{ urls: 'turn:turn.example:3478', username: 'u', password: 'p' }],
    connectionId,
  };
}

// fetchBrokerJsonWithRetry：瞬断两次后成功 → 恰好 3 次尝试 + 抖动退避。
{
  const delays = [];
  let calls = 0;
  const response = await fetchBrokerJsonWithRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw transientError();
      return Response.json({ ok: true });
    },
    'https://broker.example/v1/x',
    {},
    { sleep: (ms) => { delays.push(ms); return Promise.resolve(); }, random: () => 1 },
  );
  assertEq(await response.json(), { ok: true }, '瞬断后最终成功返回响应体');
  assertEq(calls, 3, '瞬断重试达到 3 次尝试');
  assertEq(delays.join(','), '250,500', '指数退避序列（无抖动）');
}

// 5xx 网关类响应重试；4xx 不重试。
{
  let calls = 0;
  const response = await fetchBrokerJsonWithRetry(
    async () => {
      calls += 1;
      if (calls < 3) return new Response('{"code":"bad_gateway"}', { status: 502 });
      return Response.json({ ok: true });
    },
    'https://broker.example/v1/x',
    {},
    { sleep: noSleep },
  );
  assertEq(await response.json(), { ok: true }, '5xx 重试后成功');
  assertEq(calls, 3, '502/503/504 重试共 3 次尝试');

  calls = 0;
  const notFound = await fetchBrokerJsonWithRetry(
    async () => { calls += 1; return new Response('{"code":"nope"}', { status: 404 }); },
    'https://broker.example/v1/x',
    {},
    { sleep: noSleep },
  );
  assertEq(notFound.status, 404, '4xx 原样返回给调用方映射');
  assertEq(calls, 1, '4xx 不重试');
}

// 未分类错误一次失败；调用方中止不重试。
{
  let calls = 0;
  await assert.rejects(
    () => fetchBrokerJsonWithRetry(
      async () => { calls += 1; throw new Error('boom'); },
      'https://broker.example/v1/x',
      {},
      { sleep: noSleep },
    ),
    /boom/,
    '未知错误直接上抛',
  );
  assertEq(calls, 1, '未知错误不重试');

  calls = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => fetchBrokerJsonWithRetry(
      async (url, options) => {
        calls += 1;
        throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      },
      'https://broker.example/v1/x',
      { signal: controller.signal },
      { sleep: noSleep },
    ),
    { name: 'AbortError' },
    '调用方中止直通',
  );
  assertEq(calls, 1, '调用方中止不重试');
}

// 每尝试独立超时：fetch 不理会 signal 时由超时信号触发重试。
{
  let calls = 0;
  const hangingFetch = (url, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(Response.json({ late: true })), 400);
    options.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(options.signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });
  await assert.rejects(
    () => fetchBrokerJsonWithRetry(
      async (url, options) => { calls += 1; return hangingFetch(url, options); },
      'https://broker.example/v1/x',
      {},
      { attempts: 2, timeoutMs: 25, sleep: noSleep },
    ),
    { name: 'TimeoutError' },
    '单次尝试超时按瞬态分类',
  );
  assertEq(calls, 2, '超时触发有界重试');
}

// 分类与退避纯函数。
{
  assertEq(isTransientBrokerFetchError(transientError('ECONNRESET')), true, 'ECONNRESET 属瞬态');
  assertEq(isTransientBrokerFetchError(transientError('UND_ERR_SOCKET')), true, 'undici socket 错误属瞬态');
  assertEq(isTransientBrokerFetchError(Object.assign(new Error('x'), { name: 'TimeoutError' })), true, 'TimeoutError 属瞬态');
  assertEq(isTransientBrokerFetchError(new Error('x')), false, '普通错误不属瞬态');
  const noJitter = { random: () => 1 };
  assertEq(nextBrokerBackoffMs(1, noJitter), 250, '退避第 1 步');
  assertEq(nextBrokerBackoffMs(2, noJitter), 500, '退避第 2 步');
  assertEq(nextBrokerBackoffMs(4, noJitter), 2000, '退避封顶');
  assertEq(nextBrokerBackoffMs(1, { random: () => 0 }), 125, '抖动下限为一半');
}

// requestTurnCredentials：瞬断重试复用同一 Idempotency-Key。
{
  const seenKeys = [];
  let calls = 0;
  const credentials = await requestTurnCredentials({
    brokerUrl: 'https://turn.example',
    capabilityToken: 'cap-token',
    authMode: 'accounts-capability',
    accountId: 'acc',
    instanceId: 'ins',
    deviceId: 'dev',
    connectionId: 'conn-1',
    idempotencyKey: 'idem-1',
    attempts: 3,
    sleep: noSleep,
    fetchImpl: async (url, options) => {
      calls += 1;
      seenKeys.push(options.headers['Idempotency-Key']);
      if (calls === 1) throw transientError('ECONNRESET');
      return Response.json(brokerBody());
    },
  });
  assertEq(credentials.connectionId, 'conn-1', 'TURN 凭据重试后成功');
  assertEq(calls, 2, 'TURN 瞬断重试共 2 次调用');
  assertEq(seenKeys.join(','), 'idem-1,idem-1', '重试重放同一幂等键');
}

// TURN：5xx 重试、4xx 一次失败、未知错误一次失败、坏 200（代理 HTML）重试、超时重试。
{
  let calls = 0;
  const base = {
    brokerUrl: 'https://turn.example',
    capabilityToken: 'cap-token',
    authMode: 'accounts-capability',
    accountId: 'acc',
    instanceId: 'ins',
    deviceId: 'dev',
    connectionId: 'conn-1',
    idempotencyKey: 'idem-1',
    attempts: 3,
    sleep: noSleep,
  };
  const credentials = await requestTurnCredentials({
    ...base,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return new Response('{"code":"bad_gateway"}', { status: 502 });
      return Response.json(brokerBody());
    },
  });
  assertEq(credentials.connectionId, 'conn-1', 'TURN 5xx 重试后成功');
  assertEq(calls, 3, 'TURN 5xx 重试共 3 次调用');

  calls = 0;
  await assert.rejects(
    () => requestTurnCredentials({
      ...base,
      fetchImpl: async () => {
        calls += 1;
        return new Response('{"code":"unauthorized"}', { status: 400 });
      },
    }),
    (error) => error.code === 'turn_broker_unavailable' && error.statusCode === 503,
    'TURN 4xx（非 turn_ 码）沿用既有归一映射',
  );
  assertEq(calls, 1, 'TURN 4xx 不重试');

  calls = 0;
  await assert.rejects(
    () => requestTurnCredentials({
      ...base,
      fetchImpl: async () => { calls += 1; throw new Error('boom'); },
    }),
    { code: 'turn_broker_unavailable' },
    'TURN 未知错误映射保持一次失败',
  );
  assertEq(calls, 1, 'TURN 未知错误不重试');

  calls = 0;
  await assert.rejects(
    () => requestTurnCredentials({
      ...base,
      attempts: 2,
      fetchImpl: async () => {
        calls += 1;
        return new Response('<html>proxy error page</html>', { status: 200 });
      },
    }),
    { code: 'turn_broker_response_invalid' },
    'TURN 坏 200（代理 HTML）按瞬态重试后仍失败',
  );
  assertEq(calls, 2, 'TURN 坏 200 触发重试');

  calls = 0;
  const hangingFetch = (url, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(Response.json(brokerBody())), 400);
    options.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(options.signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });
  await assert.rejects(
    () => requestTurnCredentials({
      ...base,
      attempts: 2,
      timeoutMs: 25,
      fetchImpl: async (url, options) => { calls += 1; return hangingFetch(url, options); },
    }),
    { code: 'turn_broker_timeout' },
    'TURN 超时按瞬态重试后映射为 turn_broker_timeout',
  );
  assertEq(calls, 2, 'TURN 超时触发有界重试');
}

console.log(`test-broker-fetch-retry: ${passed} assertions passed`);
