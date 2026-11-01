// Accounts/TURN broker 客户端共享的传输层加固。云端链路（公网域名 + 本机
// 代理路由）存在间歇性瞬断：单次 fetch 挂死或一次瞬断都会把手机 Connect
// 卡死在 connecting。这里统一提供：每尝试独立超时 + 有界重试 + 抖动退避。
// 重试重放字节相同的已签名请求体，服务端按 requestId / Idempotency-Key 去重。
import { setTimeout as defaultSleep } from 'node:timers/promises';

export const BROKER_FETCH_DEFAULT_ATTEMPTS = 3;
export const BROKER_FETCH_DEFAULT_TIMEOUT_MS = 5_000;
export const BROKER_FETCH_DEFAULT_BACKOFF_MS = 250;
export const BROKER_FETCH_MAX_BACKOFF_MS = 2_000;

// 5xx 网关类响应通常是上游瞬断，可安全重试（幂等键由请求体携带）。
const RETRYABLE_BROKER_STATUS = new Set([502, 503, 504]);
const RETRYABLE_BROKER_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_ABORTED',
]);

export function isTransientBrokerFetchError(error) {
  if (!error || typeof error !== 'object') return false;
  // TimeoutError 来自 AbortSignal.timeout；AbortError 在调用方 signal 未中止时
  // 同样只可能是本模块的单次尝试超时。
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const code = error.cause?.code || error.code;
  return typeof code === 'string' && RETRYABLE_BROKER_ERROR_CODES.has(code);
}

export function isRetryableBrokerStatus(status) {
  return RETRYABLE_BROKER_STATUS.has(status);
}

export function nextBrokerBackoffMs(attempt, {
  backoffMs = BROKER_FETCH_DEFAULT_BACKOFF_MS,
  maxBackoffMs = BROKER_FETCH_MAX_BACKOFF_MS,
  random = Math.random,
} = {}) {
  const step = Math.max(0, Number(backoffMs) || 0) * 2 ** Math.max(0, attempt - 1);
  const ceiling = Math.max(0, Number(maxBackoffMs) || 0);
  const base = Math.min(step, ceiling || step);
  return Math.max(0, Math.round(base * (0.5 + 0.5 * random())));
}

async function closeUnreadBody(response) {
  try { await response.body?.cancel?.(); } catch {}
}

export async function fetchBrokerJsonWithRetry(fetchImpl, url, options = {}, {
  attempts = BROKER_FETCH_DEFAULT_ATTEMPTS,
  timeoutMs = BROKER_FETCH_DEFAULT_TIMEOUT_MS,
  backoffMs,
  maxBackoffMs,
  random,
  sleep = defaultSleep,
} = {}) {
  const totalAttempts = Math.max(1, Math.min(Number(attempts) || 1, 5));
  const attemptTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
  let lastError;
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const isLastAttempt = attempt >= totalAttempts;
    let signal = options.signal || undefined;
    if (attemptTimeoutMs > 0) {
      const attemptTimeout = AbortSignal.timeout(attemptTimeoutMs);
      if (signal && typeof AbortSignal.any === 'function') {
        signal = AbortSignal.any([signal, attemptTimeout]);
      } else if (!signal) {
        signal = attemptTimeout;
      }
    }
    let response;
    try {
      response = await fetchImpl(url, { ...options, signal });
    } catch (error) {
      // 调用方主动中止不属于瞬态，立即上抛；其余按瞬态分类决定是否重试。
      if (options.signal?.aborted || isLastAttempt || !isTransientBrokerFetchError(error)) throw error;
      lastError = error;
      await sleep(nextBrokerBackoffMs(attempt, { backoffMs, maxBackoffMs, random }));
      continue;
    }
    if (!isLastAttempt && isRetryableBrokerStatus(response.status)) {
      lastError = Object.assign(new Error(`broker responded ${response.status}`), { statusCode: response.status });
      await closeUnreadBody(response);
      await sleep(nextBrokerBackoffMs(attempt, { backoffMs, maxBackoffMs, random }));
      continue;
    }
    return response;
  }
  throw lastError;
}
