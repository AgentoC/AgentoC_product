#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createBackgroundAiQueue } from '../chat/background-ai-queue.mjs';
import { createAiCircuitBreaker } from '../chat/ai-circuit-breaker.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 1. Global concurrency 1: a second task starts only after the first finishes.
{
  const queue = createBackgroundAiQueue({ enabled: true, concurrency: 1, delayMs: 0, maxQueue: 10 });
  const order = [];
  const first = queue.enqueue('first', async () => {
    order.push('first-start');
    await sleep(30);
    order.push('first-end');
    return 'A';
  });
  const second = queue.enqueue('second', async () => {
    order.push('second-start');
    return 'B';
  });
  assert.equal(await first, 'A');
  assert.equal(await second, 'B');
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start'], 'concurrency must be serialized');
}

// 2. Same-key dedupe: a duplicate enqueue is skipped without running the task.
{
  const queue = createBackgroundAiQueue({ enabled: true, concurrency: 1, delayMs: 0, maxQueue: 10 });
  let calls = 0;
  const first = queue.enqueue('dedupe-key', async () => {
    calls += 1;
    await sleep(20);
    return 'first-result';
  });
  const duplicate = queue.enqueue('dedupe-key', async () => {
    calls += 1;
    return 'duplicate-result';
  });
  assert.equal(await first, 'first-result');
  assert.deepEqual(await duplicate, { ok: false, skipped: 'dedupe' });
  assert.equal(calls, 1, 'deduplicated task must not run');
}

// 3. Queue full: overflow tasks are skipped with a clear result.
{
  const queue = createBackgroundAiQueue({ enabled: true, concurrency: 1, delayMs: 0, maxQueue: 2 });
  const blocker = queue.enqueue('blocker', async () => {
    await sleep(40);
    return 'blocker-done';
  });
  const queuedA = queue.enqueue('queued-a', async () => 'queued-a-done');
  const queuedB = queue.enqueue('queued-b', async () => 'queued-b-done');
  const overflow = await queue.enqueue('overflow', async () => 'overflow-done');
  assert.deepEqual(overflow, { ok: false, skipped: 'queue_full' });
  assert.equal(await blocker, 'blocker-done');
  assert.equal(await queuedA, 'queued-a-done');
  assert.equal(await queuedB, 'queued-b-done');
}

// 4. A failing task does not block later tasks.
{
  const queue = createBackgroundAiQueue({ enabled: true, concurrency: 1, delayMs: 0, maxQueue: 10 });
  const failing = queue.enqueue('failing', async () => {
    throw new Error('boom');
  });
  const healthy = queue.enqueue('healthy', async () => 'fine');
  await assert.rejects(failing, /boom/);
  assert.equal(await healthy, 'fine');
}

// 5. Delay: a task waits at least its delay before running.
{
  const queue = createBackgroundAiQueue({ enabled: true, concurrency: 1, delayMs: 40, maxQueue: 10 });
  const startedAt = Date.now();
  const result = await queue.enqueue('delayed', async () => 'delayed-done');
  assert.equal(result, 'delayed-done');
  assert.ok(Date.now() - startedAt >= 30, 'task should respect the queue delay');
}

// 6. Disabled queue: tasks run directly (rollback path).
{
  let directCalls = 0;
  const queue = createBackgroundAiQueue({ enabled: false });
  const result = await queue.enqueue('direct', async () => {
    directCalls += 1;
    return 'direct-done';
  });
  assert.equal(result, 'direct-done');
  assert.equal(directCalls, 1);
  assert.equal(queue.stats().queued, 0, 'disabled queue must not hold tasks');
}

// 7. Unkeyed tasks are serialized but never deduped.
{
  const queue = createBackgroundAiQueue({ enabled: true, concurrency: 1, delayMs: 0, maxQueue: 10 });
  const order = [];
  const first = queue.enqueue('', async () => {
    order.push('u-start');
    await sleep(25);
    order.push('u-end');
    return 'u1';
  });
  const second = queue.enqueue('', async () => {
    order.push('u2');
    return 'u2';
  });
  assert.equal(await first, 'u1');
  assert.equal(await second, 'u2');
  assert.deepEqual(order, ['u-start', 'u-end', 'u2'], 'unkeyed tasks must still serialize');
}

// 8. Hard deadline (DS-04): an entry that waits past its deadline is dropped
// instead of running stale work.
{
  const queue = createBackgroundAiQueue({ enabled: true, concurrency: 1, delayMs: 0, maxQueue: 10, deadlineMs: 40 });
  const blocker = queue.enqueue('blocker', async () => {
    await sleep(80);
    return 'blocker-done';
  });
  const stale = queue.enqueue('stale', async () => 'stale-done');
  assert.equal(await blocker, 'blocker-done');
  assert.deepEqual(await stale, { ok: false, skipped: 'deadline' });
  const counters = queue.counters();
  assert.ok(counters.skippedByReason.some(({ reason, count }) => reason === 'deadline' && count === 1),
    'deadline skip must be counted');
  assert.equal(counters.totalSkippedOther, 1);
  assert.equal(counters.deadlineMs, 40, 'stats must expose the deadline knob');
}

// 9. Per-session budget (DS-04): bounded starts per rolling window; other
// sessions are not affected.
{
  const queue = createBackgroundAiQueue({ enabled: true, concurrency: 1, delayMs: 0, maxQueue: 10, sessionBudget: 2, sessionBudgetWindowMs: 60_000 });
  const first = queue.enqueue('budget-a', async () => 'a', { sessionId: 'sess-budget' });
  const second = queue.enqueue('budget-b', async () => 'b', { sessionId: 'sess-budget' });
  assert.equal(await first, 'a');
  assert.equal(await second, 'b');
  const third = await queue.enqueue('budget-c', async () => 'c', { sessionId: 'sess-budget' });
  assert.deepEqual(third, { ok: false, skipped: 'session_budget', budget: 2, windowMs: 60_000 });
  const other = await queue.enqueue('budget-other', async () => 'other', { sessionId: 'sess-other' });
  assert.equal(other, 'other', 'a different session must be unaffected by the budget');
  assert.ok(queue.counters().skippedByReason.some(({ reason, count }) => reason === 'session_budget' && count === 1));
}

// 10. Circuit breaker gate (DS-04): an open breaker skips enqueues for the
// provider:capability pair with retryAfterMs; the default gate stays open.
{
  const breaker = createAiCircuitBreaker({ authCooldownMs: 60_000, authTripCount: 2, observeDedupeMs: 0 });
  breaker.observeOutcome({ provider: 'claude', operation: 'task_card_suggestion', errorCode: 'auth', errorMessage: '401 no', ok: false });
  breaker.observeOutcome({ provider: 'claude', operation: 'task_card_suggestion', errorCode: 'auth', errorMessage: '401 no', ok: false });
  const queue = createBackgroundAiQueue({ enabled: true, concurrency: 1, delayMs: 0, maxQueue: 10, breaker });
  const gated = await queue.enqueue('gated-key', async () => 'gated', {
    sessionId: 'sess-gated',
    provider: 'claude',
    operation: 'task_card_suggestion',
  });
  assert.equal(gated.ok, false);
  assert.equal(gated.skipped, 'breaker_open');
  assert.ok(gated.retryAfterMs > 0 && gated.retryAfterMs <= 60_000);
  const unaffected = await queue.enqueue('open-key', async () => 'open', {
    sessionId: 'sess-gated',
    provider: 'claude',
    operation: 'workflow_state_suggestion',
  });
  assert.equal(unaffected, 'open', 'sibling capability on the same provider must still run');
  assert.ok(queue.counters().skippedByReason.some(({ reason, count }) => reason === 'breaker_open' && count === 1));
}

// 11. Per-session status projection (DS-04): queued -> running -> succeeded,
// with failed outcomes carrying the error code.
{
  const queue = createBackgroundAiQueue({ enabled: true, concurrency: 1, delayMs: 0, maxQueue: 10 });
  const options = { sessionId: 'sess-proj', provider: 'claude', operation: 'task_card_suggestion' };
  const good = queue.enqueue('proj-good', async () => 'good', options);
  const running = queue.getSessionProjection('sess-proj');
  assert.equal(running.status, 'running', 'started entry must project as running');
  assert.equal(running.operation, 'task_card_suggestion');
  assert.equal(running.provider, 'claude');
  assert.equal(await good, 'good');
  const succeeded = queue.getSessionProjection('sess-proj');
  assert.equal(succeeded.status, 'succeeded');
  assert.ok(succeeded.startedAt > 0 && succeeded.finishedAt >= succeeded.startedAt);
  assert.equal(succeeded.errorCode, '');

  const failed = queue.enqueue('proj-fail', async () => {
    throw new Error('401 Unauthorized');
  }, { sessionId: 'sess-proj-fail', provider: 'claude', operation: 'workflow_state_suggestion' });
  await assert.rejects(failed, /401/);
  const projection = queue.getSessionProjection('sess-proj-fail');
  assert.equal(projection.status, 'failed');
  assert.equal(projection.errorCode, 'auth');
  assert.ok(projection.finishedAt >= projection.enqueuedAt);
  assert.equal(queue.getSessionProjection('sess-never-seen'), null, 'unknown session must project null');
}

// 12. Service shutdown drops pending best-effort tasks immediately.
{
  const queue = createBackgroundAiQueue({ enabled: true, concurrency: 1, delayMs: 40, maxQueue: 10 });
  const pending = queue.enqueue('shutdown-pending', async () => 'must-not-run');
  assert.deepEqual(queue.stop(), { dropped: 1, active: 0 });
  assert.deepEqual(await pending, { ok: false, skipped: 'shutdown' });
  assert.equal(queue.stats().queued, 0);
}

console.log('test-background-ai-queue: ok');
