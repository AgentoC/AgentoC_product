import { randomBytes } from 'node:crypto';
import { buildTemporaryBrokerMessage } from './temporary-pairing-broker-protocol.mjs';
import { signWithInstanceIdentity } from './instance-identity.mjs';
import { temporaryPairingError } from './temporary-pairing-protocol.mjs';

export const TEMPORARY_BROKER_REQUEST_TIMEOUT_MS = 30_000;

export function temporaryBrokerUrl(value, allowInsecure = false) {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:'))
    || url.username || url.password || url.search || url.hash) throw temporaryPairingError('temporary_host_broker_invalid', 503);
  return url.toString().replace(/\/$/, '');
}

export function createTemporaryPairingClient({ baseUrl, identity, clock = Date.now, fetchImpl = globalThis.fetch, allowInsecure = false }) {
  const base = temporaryBrokerUrl(baseUrl, allowInsecure);
  return {
    baseUrl: base,
    async request(action, invitationId, payload = {}, { signal } = {}) {
      const input = { instanceId: identity.instanceId, invitationId,
        requestId: `rtr_${randomBytes(24).toString('base64url')}`, issuedAt: clock(),
        nonce: `rtn_${randomBytes(24).toString('base64url')}`, payload };
      input.signature = signWithInstanceIdentity(identity, buildTemporaryBrokerMessage(action, input));
      let response;
      try {
        response = await fetchImpl(`${base}/v1/temporary-pairing/${action}`, { method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(input),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TEMPORARY_BROKER_REQUEST_TIMEOUT_MS)])
            : AbortSignal.timeout(TEMPORARY_BROKER_REQUEST_TIMEOUT_MS) });
        const reader = response.body.getReader(); const chunks = []; let size = 0;
        while (true) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.length;
          if (size > 16 * 1024) { await reader.cancel(); throw temporaryPairingError('temporary_host_response_too_large', 502); }
          chunks.push(Buffer.from(next.value));
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { if (response.ok) throw temporaryPairingError('temporary_host_response_invalid', 502); }
        if (!response.ok) {
          const code = /^temporary_[a-z0-9_]{1,65}$/.test(body?.code || '') ? body.code
            : response.status === 429 ? 'temporary_host_rate_limited' : 'temporary_host_request_failed';
          const error = temporaryPairingError(code, response.status);
          const retry = response.headers.get('retry-after');
          const seconds = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry || '') - clock();
          if (Number.isSafeInteger(seconds) && seconds > 0) error.retryAfterMs = seconds;
          throw error;
        }
        if (!body || body.invitationId !== invitationId || body.instanceId !== identity.instanceId
          || !['REGISTERED', 'CLAIMED', 'COMPLETED', 'REVOKED', 'EXPIRED'].includes(body.status)) {
          throw temporaryPairingError('temporary_host_response_invalid', 502);
        }
        return body;
      } catch (error) {
        if (typeof error?.code === 'string' && error.code.startsWith('temporary_')) throw error;
        if (signal?.aborted) throw temporaryPairingError('temporary_host_stopped', 503);
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          throw temporaryPairingError('temporary_host_timeout', 504);
        }
        throw temporaryPairingError('temporary_host_unavailable', 503);
      }
    },
  };
}
