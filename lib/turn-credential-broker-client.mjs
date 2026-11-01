// Client for the independently deployed TURN credential broker. The product
// backend never receives or stores the Cloudflare secret; it sends only an
// already-authorized account/device request and receives short-lived ICE data.
export const TURN_BROKER_PROTOCOL_VERSION = 1;
export const TURN_BROKER_DEFAULT_TIMEOUT_MS = 5000;
import { normalizeTurnBrokerAuthMode } from './turn-broker-capability.mjs';
import {
  BROKER_FETCH_DEFAULT_ATTEMPTS,
  isRetryableBrokerStatus,
  isTransientBrokerFetchError,
  nextBrokerBackoffMs,
} from './broker-fetch.mjs';
import { setTimeout as defaultSleep } from 'node:timers/promises';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createBrokerError(code, message, statusCode = 503) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

export function normalizeTurnBrokerUrl(value) {
  const raw = trimString(value).replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) return '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function assertCredentialResponse(body, { nowMs = Date.now(), connectionId = '', temporaryGrant } = {}) {
  if (!body || typeof body !== 'object' || body.protocolVersion !== TURN_BROKER_PROTOCOL_VERSION) {
    throw createBrokerError('turn_broker_response_invalid', 'TURN broker returned an unsupported response.', 502);
  }
  if (trimString(body.provider) !== 'cloudflare-realtime'
    || trimString(body.transport) !== 'turn'
    || body.appTrafficOnly !== true
    || body.credentialScope !== (temporaryGrant ? 'temporary-device-access' : 'device-access')) {
    throw createBrokerError('turn_broker_response_invalid', 'TURN broker returned invalid transport metadata.', 502);
  }
  const expiresAtMs = Date.parse(body.expiresAt || '');
  if (temporaryGrant && (body.temporaryGrantId !== temporaryGrant.grantId
    || body.temporaryInvitationId !== temporaryGrant.invitationId
    || Date.parse(body.accessExpiresAt) !== temporaryGrant.accessExpiresAt || expiresAtMs > temporaryGrant.accessExpiresAt)) {
    throw createBrokerError('turn_broker_response_invalid', 'TURN broker temporary grant binding mismatch.', 502);
  }
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs
    || !Array.isArray(body.iceServers) || body.iceServers.length < 1) {
    throw createBrokerError('turn_broker_response_invalid', 'TURN broker returned invalid or expired credentials.', 502);
  }
  for (const server of body.iceServers) {
    if (!server || !trimString(server.urls) || !trimString(server.username) || !trimString(server.password)) {
      throw createBrokerError('turn_broker_response_invalid', 'TURN broker returned incomplete ICE credentials.', 502);
    }
  }
  if (connectionId && trimString(body.connectionId) !== connectionId) {
    throw createBrokerError('turn_broker_response_invalid', 'TURN broker connection binding mismatch.', 502);
  }
  return body;
}

function normalizeBrokerAttemptError(error) {
  if (error?.name === 'AbortError') return createBrokerError('turn_broker_timeout', 'TURN credential broker timed out.', 504);
  if (error?.code && error.code.startsWith('turn_')) return error;
  return createBrokerError('turn_broker_unavailable', 'TURN credential broker is unavailable.', 503);
}

function isRetryableTurnBrokerError(mapped, original) {
  if (mapped?.code === 'turn_broker_timeout') return true;
  if (mapped?.code === 'turn_broker_unavailable') {
    // 未知错误保持一次失败；只有确属网络瞬态才重试。
    return isTransientBrokerFetchError(original);
  }
  // 代理瞬断可能返回 HTML 200/网关错误页，解析失败表现为 response_invalid，
  // 同样按瞬态处理。
  return mapped?.code === 'turn_broker_response_invalid';
}

export async function requestTurnCredentials({
  brokerUrl,
  brokerToken,
  capabilityToken,
  authMode = 'accounts-capability',
  accountId,
  instanceId,
  deviceId,
  connectionId,
  idempotencyKey,
  authorization,
  ttlMs,
  temporaryGrant,
  fetchImpl = globalThis.fetch,
  timeoutMs = TURN_BROKER_DEFAULT_TIMEOUT_MS,
  attempts = BROKER_FETCH_DEFAULT_ATTEMPTS,
  clock = Date.now,
  nowMs = clock(),
  sleep = defaultSleep,
} = {}) {
  const baseUrl = normalizeTurnBrokerUrl(brokerUrl);
  const mode = normalizeTurnBrokerAuthMode(authMode);
  if (temporaryGrant !== undefined && (mode !== 'accounts-capability'
    || !/^rtg_[A-Za-z0-9_-]{24,64}$/.test(temporaryGrant?.grantId || '')
    || !/^rti_[A-Za-z0-9_-]{24,64}$/.test(temporaryGrant?.invitationId || '')
    || !Number.isSafeInteger(temporaryGrant?.accessExpiresAt))) {
    throw createBrokerError('turn_broker_temporary_grant_invalid', 'Temporary TURN requires a device grant and Accounts capability.', 400);
  }
  const token = mode === 'accounts-capability' ? trimString(capabilityToken) : trimString(brokerToken);
  if (!baseUrl || !token) throw createBrokerError('turn_broker_not_configured', 'TURN credential broker is not configured.', 503);
  if (typeof fetchImpl !== 'function') throw createBrokerError('turn_broker_unavailable', 'TURN credential broker client is unavailable.', 503);
  const normalizedConnectionId = trimString(connectionId);
  const requestId = trimString(idempotencyKey) || normalizedConnectionId;
  if (!trimString(accountId) || !trimString(instanceId) || !trimString(deviceId) || !normalizedConnectionId || !requestId) {
    throw createBrokerError('turn_broker_request_invalid', 'TURN broker request identity is incomplete.', 400);
  }
  // 每次尝试独立超时；重试重放同一 Idempotency-Key 的字节相同请求体，
  // 由 broker 去重，避免一次瞬断把 Connect 引导直接打成失败。
  const totalAttempts = Math.max(1, Math.min(Number(attempts) || 1, 5));
  const perAttemptTimeoutMs = Math.max(250, Number(timeoutMs) || TURN_BROKER_DEFAULT_TIMEOUT_MS);
  const requestInit = {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': requestId,
    },
    body: JSON.stringify({
      protocolVersion: TURN_BROKER_PROTOCOL_VERSION,
      accountId: trimString(accountId),
      instanceId: trimString(instanceId),
      deviceId: trimString(deviceId),
      connectionId: normalizedConnectionId,
      idempotencyKey: requestId,
      ...(mode === 'accounts-capability' ? {} : {
        authorization: authorization && typeof authorization === 'object' ? authorization : { authorized: true },
      }),
      ...(Number.isFinite(Number(ttlMs)) ? { ttlMs: Number(ttlMs) } : {}),
    }),
  };
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    if (temporaryGrant && temporaryGrant.accessExpiresAt <= Math.max(nowMs, clock())) {
      throw createBrokerError('turn_broker_temporary_expiring', 'Temporary authorization expired before credential delivery.', 410);
    }
    const isLastAttempt = attempt >= totalAttempts;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), perAttemptTimeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/v1/turn/credentials`, { ...requestInit, redirect: 'error', signal: controller.signal });
      let body = null;
      try { body = await response.json(); } catch {}
      if (!response.ok) {
        const error = createBrokerError(
          trimString(body?.code) || 'turn_broker_rejected',
          'TURN credential broker rejected the request.',
          response.status || 502,
        );
        if (!isLastAttempt && isRetryableBrokerStatus(response.status)) {
          await sleep(nextBrokerBackoffMs(attempt));
          continue;
        }
        throw error;
      }
      return assertCredentialResponse(body, { nowMs: temporaryGrant ? Math.max(nowMs, clock()) : nowMs,
        connectionId: normalizedConnectionId, temporaryGrant });
    } catch (error) {
      const mapped = normalizeBrokerAttemptError(error);
      if (!isLastAttempt && isRetryableTurnBrokerError(mapped, error)) {
        await sleep(nextBrokerBackoffMs(attempt));
        continue;
      }
      throw mapped;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw createBrokerError('turn_broker_unavailable', 'TURN credential broker is unavailable.', 503);
}
