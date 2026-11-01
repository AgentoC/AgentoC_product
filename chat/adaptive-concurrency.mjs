// Runtime adaptive concurrency budget.
//
// This module deliberately contains no provider or queue-specific policy. It
// is a small, dependency-free control loop that can be placed in front of
// history reads, projection work, background AI, or detached harness starts.
// The caller supplies latency/error/pressure samples and decides which
// budget a task belongs to. A budget change only affects future acquisitions;
// leases already handed out are never revoked.

const PRIORITY_WEIGHT = Object.freeze({
  interactive: 100,
  connector: 80,
  normal: 50,
  background: 10,
});

const DEFAULTS = Object.freeze({
  minLimit: 1,
  initialLimit: 1,
  maxLimit: 16,
  targetLatencyMs: 250,
  sampleWindowMs: 5_000,
  cooldownMs: 20_000,
  increaseStep: 1,
  decreaseFactor: 0.7,
  healthyLatencyFactor: 1.1,
  congestedLatencyFactor: 1.3,
  healthyEventLoopUtilization: 0.75,
  congestedEventLoopUtilization: 0.9,
  healthyEventLoopDelayP99Ms: 50,
  congestedEventLoopDelayP99Ms: 100,
  healthyMemoryUtilization: 0.75,
  congestedMemoryUtilization: 0.85,
  maxQueue: 1_000,
  maxSamples: 512,
});

function finiteNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values
    .map((value) => finiteNumber(value, null))
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function normalizeMode(value) {
  const mode = String(value || 'on').trim().toLowerCase();
  return mode === 'off' || mode === 'shadow' || mode === 'on' ? mode : 'on';
}

function priorityWeight(priority) {
  if (Number.isFinite(Number(priority))) return Number(priority);
  return PRIORITY_WEIGHT[String(priority || 'normal').trim().toLowerCase()] || PRIORITY_WEIGHT.normal;
}

function makeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function monotonicMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

/**
 * Create a bounded, observable concurrency budget.
 *
 * The budget is intentionally usable without a timer. Callers that already
 * own a process-wide sampler may invoke tick(signals) from that sampler;
 * startAutoTick() is provided for standalone consumers and always unrefs its
 * timer so it cannot keep the process alive.
 */
export function createAdaptiveConcurrencyBudget(options = {}) {
  const configuredMin = positiveInt(options.minLimit, DEFAULTS.minLimit);
  const configuredMax = Math.max(
    configuredMin,
    positiveInt(options.maxLimit, DEFAULTS.maxLimit),
  );
  const configuredInitial = clamp(
    positiveInt(options.initialLimit, configuredMin),
    configuredMin,
    configuredMax,
  );
  const name = String(options.name || 'adaptive').trim() || 'adaptive';
  const mode = normalizeMode(options.mode);
  const targetLatencyMs = Math.max(1, finiteNumber(options.targetLatencyMs, DEFAULTS.targetLatencyMs));
  const sampleWindowMs = Math.max(250, nonNegativeInt(options.sampleWindowMs, DEFAULTS.sampleWindowMs));
  const cooldownMs = Math.max(0, nonNegativeInt(options.cooldownMs, DEFAULTS.cooldownMs));
  const increaseStep = Math.max(1, positiveInt(options.increaseStep, DEFAULTS.increaseStep));
  const decreaseFactor = clamp(
    finiteNumber(options.decreaseFactor, DEFAULTS.decreaseFactor),
    0.1,
    0.95,
  );
  const maxQueue = nonNegativeInt(options.maxQueue, DEFAULTS.maxQueue);
  const maxSamples = Math.max(8, positiveInt(options.maxSamples, DEFAULTS.maxSamples));

  let currentLimit = configuredInitial;
  let desiredLimit = configuredInitial;
  let active = 0;
  let queued = 0;
  let sequence = 0;
  let sampleWindow = [];
  let timer = null;
  let closed = false;
  let lastDecision = 'initial';
  let lastReason = 'initial';
  let lastChangedAt = 0;
  let lastTickAt = 0;
  let healthyWindows = 0;
  let congestedWindows = 0;
  let totalAcquired = 0;
  let totalCompleted = 0;
  let totalErrors = 0;
  let totalTimeouts = 0;
  let totalCancelled = 0;
  const waiters = [];

  function effectiveLimit() {
    // `off` must mean fixed legacy admission, not a second spelling of `on`.
    return mode === 'on' ? currentLimit : configuredInitial;
  }

  function sortWaiters() {
    waiters.sort((left, right) => {
      const weightDelta = priorityWeight(right.priority) - priorityWeight(left.priority);
      if (weightDelta !== 0) return weightDelta;
      return left.sequence - right.sequence;
    });
  }

  function removeWaiter(waiter) {
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    if (!waiter.started && !waiter.settled) queued = Math.max(0, queued - 1);
  }

  function makeLease(waiter) {
    active += 1;
    totalAcquired += 1;
    waiter.started = true;
    const startedAt = monotonicMs();
    let released = false;
    return {
      budget: name,
      sequence: waiter.sequence,
      startedAt,
      queueWaitMs: Math.max(0, startedAt - waiter.enqueuedAt),
      release(sample = {}) {
        if (released) return false;
        released = true;
        active = Math.max(0, active - 1);
        const durationMs = Math.max(
          0,
          finiteNumber(sample.durationMs, monotonicMs() - startedAt),
        );
        const outcome = String(sample.outcome || 'success').trim().toLowerCase();
        totalCompleted += 1;
        if (outcome === 'error' || outcome === 'failed') totalErrors += 1;
        if (outcome === 'timeout') totalTimeouts += 1;
        if (outcome === 'cancelled' || outcome === 'canceled') totalCancelled += 1;
        observe({
          durationMs,
          queueWaitMs: Math.max(0, finiteNumber(sample.queueWaitMs, startedAt - waiter.enqueuedAt)),
          outcome,
          providerThrottled: sample.providerThrottled === true,
        });
        pump();
        return true;
      },
    };
  }

  function settleWaiter(waiter, error, lease) {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    if (error) waiter.reject(error);
    else waiter.resolve(lease);
  }

  function pump() {
    if (closed) return;
    sortWaiters();
    while (active < effectiveLimit() && waiters.length > 0) {
      const waiter = waiters.shift();
      if (!waiter || waiter.settled) continue;
      // queued counts waiters that are still pending, not all acquisitions
      // that have ever passed through the queue.
      queued = Math.max(0, queued - 1);
      const lease = makeLease(waiter);
      settleWaiter(waiter, null, lease);
    }
  }

  function tryAcquire(meta = {}) {
    if (closed) return null;
    if (active >= effectiveLimit()) return null;
    const waiter = {
      sequence: ++sequence,
      priority: meta.priority || 'normal',
      enqueuedAt: monotonicMs(),
      started: false,
      settled: false,
    };
    return makeLease(waiter);
  }

  // Re-attach an already running task after a control-plane restart. Adoption
  // intentionally bypasses the current limit so recovery does not kill or
  // duplicate work; the resulting active count still prevents new work from
  // starting until capacity is available again.
  function adopt(meta = {}) {
    if (closed) return null;
    const waiter = {
      sequence: ++sequence,
      priority: meta.priority || 'normal',
      enqueuedAt: monotonicMs(),
      started: false,
      settled: false,
    };
    return makeLease(waiter);
  }

  function acquire({
    wait = true,
    priority = 'normal',
    signal = null,
    deadlineMs = 0,
  } = {}) {
    const immediate = tryAcquire({ priority });
    if (immediate || !wait) return Promise.resolve(immediate);
    if (closed) return Promise.reject(makeError('ADAPTIVE_CONCURRENCY_CLOSED', `${name} is closed`));
    if (maxQueue >= 0 && queued >= maxQueue) {
      return Promise.reject(makeError('ADAPTIVE_CONCURRENCY_QUEUE_FULL', `${name} queue is full`));
    }
    if (signal?.aborted) {
      return Promise.reject(makeError('ABORT_ERR', `${name} acquisition was cancelled`));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        sequence: ++sequence,
        priority,
        enqueuedAt: monotonicMs(),
        started: false,
        settled: false,
        resolve,
        reject,
        signal,
        timer: null,
        onAbort: null,
      };
      queued += 1;
      if (Number.isFinite(deadlineMs) && deadlineMs > 0) {
        waiter.timer = setTimeout(() => {
          if (waiter.settled || waiter.started) return;
          removeWaiter(waiter);
          settleWaiter(waiter, makeError('ADAPTIVE_CONCURRENCY_TIMEOUT', `${name} acquisition timed out`));
        }, deadlineMs);
        waiter.timer.unref?.();
      }
      if (signal) {
        waiter.onAbort = () => {
          if (waiter.settled || waiter.started) return;
          removeWaiter(waiter);
          settleWaiter(waiter, makeError('ABORT_ERR', `${name} acquisition was cancelled`));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      waiters.push(waiter);
      pump();
    });
  }

  function observe(sample = {}) {
    const durationMs = finiteNumber(sample.durationMs, null);
    if (durationMs === null || durationMs < 0) return false;
    sampleWindow.push({
      durationMs,
      queueWaitMs: Math.max(0, finiteNumber(sample.queueWaitMs, 0)),
      outcome: String(sample.outcome || 'success').trim().toLowerCase(),
      providerThrottled: sample.providerThrottled === true,
      at: Date.now(),
    });
    if (sampleWindow.length > maxSamples) sampleWindow.splice(0, sampleWindow.length - maxSamples);
    return true;
  }

  function setLimit(nextLimit, { reason = 'manual', source = 'manual' } = {}) {
    const next = clamp(Math.round(finiteNumber(nextLimit, currentLimit)), configuredMin, configuredMax);
    desiredLimit = next;
    if (mode !== 'on') {
      lastDecision = mode;
      lastReason = reason;
      return currentLimit;
    }
    if (next !== currentLimit) {
      currentLimit = next;
      lastChangedAt = Date.now();
      pump();
    }
    lastDecision = source;
    lastReason = reason;
    return currentLimit;
  }

  function tick(signals = {}) {
    if (closed) return snapshot();
    const now = Date.now();
    if (lastTickAt > 0 && now - lastTickAt < sampleWindowMs / 2) return snapshot();
    lastTickAt = now;

    const durations = sampleWindow.map((sample) => sample.durationMs);
    const queueWaits = sampleWindow.map((sample) => sample.queueWaitMs);
    const p95Ms = finiteNumber(signals.p95LatencyMs, percentile(durations, 0.95));
    const queueWaitP95Ms = finiteNumber(signals.queueWaitP95Ms, percentile(queueWaits, 0.95));
    const sampleCount = sampleWindow.length;
    const errors = sampleWindow.filter((sample) => ['error', 'failed', 'timeout'].includes(sample.outcome)).length;
    const throttles = sampleWindow.filter((sample) => sample.providerThrottled).length;
    const errorRate = finiteNumber(signals.errorRate, sampleCount > 0 ? errors / sampleCount : 0);
    const throttleRate = finiteNumber(signals.providerThrottleRate, sampleCount > 0 ? throttles / sampleCount : 0);
    const eventLoopUtilization = finiteNumber(signals.eventLoopUtilization, null);
    const eventLoopDelayP99Ms = finiteNumber(signals.eventLoopDelayP99Ms, null);
    const memoryUtilization = finiteNumber(signals.memoryUtilization, null);
    const queueDepth = Math.max(queued, nonNegativeInt(signals.queueDepth, 0));
    const latencyCongested = p95Ms !== null && p95Ms > targetLatencyMs * DEFAULTS.congestedLatencyFactor;
    const latencyHealthy = p95Ms !== null && p95Ms <= targetLatencyMs * DEFAULTS.healthyLatencyFactor;
    const eventLoopCongested = eventLoopUtilization !== null && eventLoopUtilization > DEFAULTS.congestedEventLoopUtilization;
    const eventLoopHealthy = eventLoopUtilization === null || eventLoopUtilization <= DEFAULTS.healthyEventLoopUtilization;
    const delayCongested = eventLoopDelayP99Ms !== null && eventLoopDelayP99Ms > DEFAULTS.congestedEventLoopDelayP99Ms;
    const delayHealthy = eventLoopDelayP99Ms === null || eventLoopDelayP99Ms <= DEFAULTS.healthyEventLoopDelayP99Ms;
    const memoryCongested = memoryUtilization !== null && memoryUtilization > DEFAULTS.congestedMemoryUtilization;
    const memoryHealthy = memoryUtilization === null || memoryUtilization <= DEFAULTS.healthyMemoryUtilization;
    const congested = latencyCongested || eventLoopCongested || delayCongested || memoryCongested || errorRate >= 0.1 || throttleRate >= 0.05;
    // A budget can be driven by an external queue (for example the durable
    // detached-run queue), so its own waiter count may stay at zero while
    // work is actively flowing. Treat active work as demand as well; idle
    // budgets still do not grow because sampleCount is zero after a quiet
    // window.
    const healthy = (queueDepth > 0 || active > 0)
      && sampleCount > 0
      && latencyHealthy
      && eventLoopHealthy
      && delayHealthy
      && memoryHealthy
      && errorRate < 0.02
      && throttleRate === 0;

    if (congested) {
      congestedWindows += 1;
      healthyWindows = 0;
    } else if (healthy) {
      healthyWindows += 1;
      congestedWindows = 0;
    } else {
      healthyWindows = 0;
      congestedWindows = 0;
    }

    const inCooldown = cooldownMs > 0 && lastChangedAt > 0 && now - lastChangedAt < cooldownMs;
    if (!inCooldown && congested) {
      setLimit(Math.floor(currentLimit * decreaseFactor), {
        reason: latencyCongested
          ? 'latency'
          : eventLoopCongested || delayCongested
            ? 'event_loop_pressure'
            : memoryCongested
              ? 'memory_pressure'
              : throttleRate > 0
                ? 'provider_throttle'
                : 'errors',
        source: 'decrease',
      });
    } else if (!inCooldown && healthy && healthyWindows >= 2) {
      setLimit(currentLimit + increaseStep, { reason: 'healthy_window', source: 'increase' });
      healthyWindows = 0;
    } else if (!congested && !healthy) {
      lastDecision = 'hold';
      lastReason = 'insufficient_signal';
    }

    sampleWindow = [];
    return snapshot({ p95Ms, queueWaitP95Ms, errorRate, throttleRate, queueDepth, sampleCount });
  }

  function startAutoTick(readSignals, intervalMs = sampleWindowMs) {
    if (typeof readSignals !== 'function') throw new TypeError('startAutoTick(readSignals): function required');
    if (timer) clearInterval(timer);
    const cadence = Math.max(250, nonNegativeInt(intervalMs, sampleWindowMs));
    timer = setInterval(() => {
      let signals = {};
      try {
        signals = readSignals() || {};
      } catch {
        signals = {};
      }
      tick(signals);
    }, cadence);
    timer.unref?.();
    return () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
  }

  function close(error = makeError('ADAPTIVE_CONCURRENCY_CLOSED', `${name} is closed`)) {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (!waiter || waiter.settled) continue;
      settleWaiter(waiter, error);
    }
    queued = 0;
  }

  function snapshot(extra = {}) {
    return {
      name,
      mode,
      minLimit: configuredMin,
      maxLimit: configuredMax,
      initialLimit: configuredInitial,
      currentLimit,
      effectiveLimit: effectiveLimit(),
      desiredLimit,
      active,
      queued,
      queueCapacity: maxQueue,
      totalAcquired,
      totalCompleted,
      totalErrors,
      totalTimeouts,
      totalCancelled,
      lastDecision,
      lastReason,
      lastChangedAt: lastChangedAt || null,
      lastTickAt: lastTickAt || null,
      closed,
      ...extra,
    };
  }

  return Object.freeze({
    name,
    get minLimit() { return configuredMin; },
    get maxLimit() { return configuredMax; },
    get initialLimit() { return configuredInitial; },
    get currentLimit() { return currentLimit; },
    get effectiveLimit() { return effectiveLimit(); },
    get active() { return active; },
    get queued() { return queued; },
    tryAcquire,
    adopt,
    acquire,
    observe,
    tick,
    setLimit,
    startAutoTick,
    close,
    snapshot,
  });
}

export const ADAPTIVE_CONCURRENCY_DEFAULTS = DEFAULTS;

export function __percentileForTest(values, fraction) {
  return percentile(values, fraction);
}
