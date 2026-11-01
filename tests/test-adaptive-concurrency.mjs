import assert from 'node:assert/strict';
import { createAdaptiveConcurrencyBudget, __percentileForTest } from '../chat/adaptive-concurrency.mjs';

assert.equal(__percentileForTest([10, 20, 30, 40], 0.5), 20, 'percentile should use a stable upper sample');

const budget = createAdaptiveConcurrencyBudget({
  name: 'unit',
  minLimit: 1,
  initialLimit: 2,
  maxLimit: 4,
  targetLatencyMs: 100,
  sampleWindowMs: 250,
  cooldownMs: 0,
});
const first = await budget.acquire({ priority: 'interactive' });
const second = await budget.acquire({ priority: 'background' });
assert.equal(budget.active, 2);
assert.equal(await budget.acquire({ wait: false }), null, 'try-acquire must respect the current limit');

const waiting = budget.acquire({ priority: 'interactive', deadlineMs: 1_000 });
setTimeout(() => first.release({ durationMs: 10 }), 10);
const third = await waiting;
assert.equal(budget.active, 2, 'a released slot should wake one waiter');
assert.equal(budget.queued, 0, 'woken waiters must leave the pending queue');
third.release({ durationMs: 10 });
second.release({ durationMs: 10 });
assert.equal(budget.active, 0);

const bounded = createAdaptiveConcurrencyBudget({
  name: 'bounded-queue',
  minLimit: 1,
  initialLimit: 1,
  maxLimit: 1,
  maxQueue: 1,
});
const boundedFirst = await bounded.acquire();
const boundedSecondWaiting = bounded.acquire();
boundedFirst.release({ durationMs: 1 });
const boundedSecond = await boundedSecondWaiting;
assert.equal(bounded.queued, 0, 'a drained waiter must not consume queue capacity');
const boundedThirdWaiting = bounded.acquire();
boundedSecond.release({ durationMs: 1 });
const boundedThird = await boundedThirdWaiting;
boundedThird.release({ durationMs: 1 });

budget.observe({ durationMs: 10, outcome: 'success' });
budget.observe({ durationMs: 10, outcome: 'success' });
await new Promise((resolve) => setTimeout(resolve, 130));
budget.tick({ queueDepth: 1, eventLoopUtilization: 0.1, eventLoopDelayP99Ms: 1, memoryUtilization: 0.1 });
budget.observe({ durationMs: 10, outcome: 'success' });
budget.observe({ durationMs: 10, outcome: 'success' });
await new Promise((resolve) => setTimeout(resolve, 130));
budget.tick({ queueDepth: 1, eventLoopUtilization: 0.1, eventLoopDelayP99Ms: 1, memoryUtilization: 0.1 });
budget.observe({ durationMs: 10, outcome: 'success' });
await new Promise((resolve) => setTimeout(resolve, 130));
budget.tick({ queueDepth: 1, eventLoopUtilization: 0.1, eventLoopDelayP99Ms: 1, memoryUtilization: 0.1 });
budget.observe({ durationMs: 10, outcome: 'success' });
await new Promise((resolve) => setTimeout(resolve, 130));
budget.tick({ queueDepth: 1, eventLoopUtilization: 0.1, eventLoopDelayP99Ms: 1, memoryUtilization: 0.1 });
assert.equal(budget.currentLimit, 4, 'two healthy windows should increase the limit additively');

budget.observe({ durationMs: 500, outcome: 'success' });
await new Promise((resolve) => setTimeout(resolve, 130));
budget.tick({ queueDepth: 1, eventLoopUtilization: 0.95, eventLoopDelayP99Ms: 150, memoryUtilization: 0.9 });
assert.equal(budget.currentLimit, 2, 'pressure should reduce the limit multiplicatively');

const adopted = budget.adopt({ priority: 'interactive' });
assert.ok(adopted, 'active work should be adoptable during restart recovery');
const recoveredPeer = budget.tryAcquire();
assert.ok(recoveredPeer, 'capacity remaining below the limit is still usable');
assert.equal(budget.tryAcquire(), null, 'adopted work must consume capacity');
adopted.release({ outcome: 'success', durationMs: 1 });
recoveredPeer.release({ outcome: 'success', durationMs: 1 });

const shadow = createAdaptiveConcurrencyBudget({
  name: 'shadow',
  mode: 'shadow',
  minLimit: 1,
  initialLimit: 2,
  maxLimit: 4,
});
shadow.setLimit(4, { reason: 'test' });
assert.equal(shadow.currentLimit, 2, 'shadow mode must not change real capacity');
assert.equal(shadow.snapshot().desiredLimit, 4);

const disabled = createAdaptiveConcurrencyBudget({
  name: 'disabled', mode: 'off', minLimit: 1, initialLimit: 2, maxLimit: 4,
});
disabled.setLimit(4, { reason: 'test' });
assert.equal(disabled.currentLimit, 2, 'off mode must keep the configured fixed capacity');
assert.equal(disabled.effectiveLimit, 2, 'off mode must not silently behave like adaptive on mode');

const abortBudget = createAdaptiveConcurrencyBudget({ name: 'abort', minLimit: 1, initialLimit: 1, maxLimit: 1 });
const held = await abortBudget.acquire();
const controller = new AbortController();
const aborted = abortBudget.acquire({ signal: controller.signal });
controller.abort();
await assert.rejects(aborted, (error) => error.code === 'ABORT_ERR');
held.release({ durationMs: 1 });

console.log('test-adaptive-concurrency: passed');
