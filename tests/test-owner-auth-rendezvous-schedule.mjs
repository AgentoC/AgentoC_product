#!/usr/bin/env node
// 会合轮询间隔决策的契约测试：
// bound 空闲必须退到稳态间隔（不再 2s 常驻打满 Accounts POST 限流），
// 完成加入后短暂快轮询，429 遵守 Retry-After，其余错误指数退避封顶。
import assert from 'assert/strict';

const {
  RENDEZVOUS_POLL_BASE_DELAY_MS,
  RENDEZVOUS_POLL_STEADY_DELAY_MS,
  RENDEZVOUS_POLL_IDLE_DELAY_MS,
  RENDEZVOUS_POLL_MAX_DELAY_MS,
  applyPollJitter,
  nextRendezvousPollDelayMs,
} = await import('../lib/owner-auth-rendezvous-schedule.mjs');

let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };

check('negotiated bounded inbox wait has no second blind polling gap', () => {
  assert.equal(nextRendezvousPollDelayMs({ result: { handled: false, reason: 'pending', inboxWaitVersion: 1 } }), 0);
  assert.equal(nextRendezvousPollDelayMs({ result: { handled: true, inboxWaitVersion: 1 } }), 0);
  assert.equal(nextRendezvousPollDelayMs({ result: { handled: false, reason: 'not-bound', inboxWaitVersion: 1 } }), RENDEZVOUS_POLL_IDLE_DELAY_MS);
});

check('bound 空闲（pending）退到带抖动的稳态间隔', () => {
  const low = nextRendezvousPollDelayMs({ result: { handled: false, reason: 'pending' }, random: () => 0 });
  const high = nextRendezvousPollDelayMs({ result: { handled: false, reason: 'pending' }, random: () => 1 });
  assert.equal(low, Math.round(RENDEZVOUS_POLL_STEADY_DELAY_MS * 0.85));
  assert.equal(high, Math.round(RENDEZVOUS_POLL_STEADY_DELAY_MS * 1.15));
  assert.equal(nextRendezvousPollDelayMs({ result: { handled: false, reason: 'pending' }, random: () => 0.5 }), RENDEZVOUS_POLL_STEADY_DELAY_MS);
});

check('bound target 最多约 4.6 秒领取新的手机 rendezvous', () => {
  assert.equal(RENDEZVOUS_POLL_STEADY_DELAY_MS, 4_000);
  assert.equal(
    nextRendezvousPollDelayMs({ result: { handled: false, reason: 'pending' }, random: () => 1 }),
    4_600,
  );
});

check('刚完成一次加入后下一拍保持快轮询', () => {
  assert.equal(nextRendezvousPollDelayMs({ result: { handled: true, requestId: 'opll_1' }, random: () => 0 }), RENDEZVOUS_POLL_BASE_DELAY_MS);
});

check('未绑定/未配置保持慢速 IDLE 间隔', () => {
  assert.equal(nextRendezvousPollDelayMs({ result: { handled: false, reason: 'not-bound' } }), RENDEZVOUS_POLL_IDLE_DELAY_MS);
  assert.equal(nextRendezvousPollDelayMs({ result: { handled: false, reason: 'accounts-unconfigured' } }), RENDEZVOUS_POLL_IDLE_DELAY_MS);
});

check('429 优先遵守 Retry-After', () => {
  const error = Object.assign(new Error('rate limited'), { code: 'owner_auth_broker_rate_limited', retryAfterMs: 9000 });
  assert.equal(nextRendezvousPollDelayMs({ error, currentDelayMs: RENDEZVOUS_POLL_BASE_DELAY_MS }), 9000);
});

check('429 无 Retry-After 时按当前间隔翻倍', () => {
  const error = Object.assign(new Error('rate limited'), { code: 'owner_auth_broker_rate_limited', retryAfterMs: 0 });
  assert.equal(nextRendezvousPollDelayMs({ error, currentDelayMs: 8000 }), 16000);
});

check('其他错误指数退避并封顶', () => {
  const error = new Error('rejected');
  assert.equal(nextRendezvousPollDelayMs({ error, currentDelayMs: 8000 }), 16000);
  assert.equal(
    nextRendezvousPollDelayMs({ error, currentDelayMs: RENDEZVOUS_POLL_MAX_DELAY_MS }),
    RENDEZVOUS_POLL_MAX_DELAY_MS,
  );
});

check('Retry-After is not shortened by the ordinary backoff limit', () => {
  const short = Object.assign(new Error('x'), { code: 'owner_auth_broker_rate_limited', retryAfterMs: 50 });
  assert.equal(nextRendezvousPollDelayMs({ error: short }), RENDEZVOUS_POLL_BASE_DELAY_MS);
  const long = Object.assign(new Error('x'), { code: 'owner_auth_broker_rate_limited', retryAfterMs: 600_000 });
  assert.equal(nextRendezvousPollDelayMs({ error: long }), 600_000);
});

check('抖动不产生负值且落在 ±15% 区间', () => {
  assert.equal(applyPollJitter(10_000, { random: () => 0 }), 8500);
  assert.equal(applyPollJitter(10_000, { random: () => 1 }), 11500);
  const value = applyPollJitter(10_000);
  assert.ok(value >= 8500 && value <= 11_500, `jitter out of range: ${value}`);
});

console.log(`test-owner-auth-rendezvous-schedule: ${passed} assertions passed`);
