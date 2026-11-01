import { randomBytes } from 'node:crypto';
import { buildTemporaryControlBrokerMessage } from './temporary-control-broker-protocol.mjs';
import { signWithInstanceIdentity } from './instance-identity.mjs';
import { temporaryBrokerUrl, TEMPORARY_BROKER_REQUEST_TIMEOUT_MS } from './temporary-pairing-client.mjs';
import { temporaryPairingError } from './temporary-pairing-protocol.mjs';

const statuses = new Set(['REGISTERED', 'CLAIMED', 'ACTIVE', 'REVOKED', 'EXPIRED']);
const id = (prefix) => `${prefix}_${randomBytes(24).toString('base64url')}`;

/** Authenticated desktop-side client for the isolated v2 exchange. */
export function createTemporaryControlClient({ baseUrl, identity, clock = Date.now, fetchImpl = globalThis.fetch, allowInsecure = false }) {
  const base = temporaryBrokerUrl(baseUrl, allowInsecure);
  return Object.freeze({
    baseUrl: base,
    async request(action, invitationId, payload = {}, { signal } = {}) {
      const input = { instanceId: identity.instanceId, invitationId, requestId: id('rtr'), issuedAt: clock(), nonce: id('rtn'), payload };
      input.signature = signWithInstanceIdentity(identity, buildTemporaryControlBrokerMessage(action, input));
      try {
        const response = await fetchImpl(`${base}/v1/temporary-control/${action}`, { method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(input),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TEMPORARY_BROKER_REQUEST_TIMEOUT_MS)])
            : AbortSignal.timeout(TEMPORARY_BROKER_REQUEST_TIMEOUT_MS) });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 16 * 1024) throw temporaryPairingError('temporary_control_host_response_too_large', 502);
        let body;
        try { body = JSON.parse(bytes.toString('utf8')); }
        catch { if (response.ok) throw temporaryPairingError('temporary_control_host_response_invalid', 502); }
        if (!response.ok) {
          const code = /^temporary_control_[a-z0-9_]{1,65}$/.test(body?.code || '') ? body.code
            : response.status === 429 ? 'temporary_control_host_rate_limited' : 'temporary_control_host_request_failed';
          throw temporaryPairingError(code, response.status);
        }
        if (!body || body.invitationId !== invitationId || body.instanceId !== identity.instanceId || !statuses.has(body.status)) {
          throw temporaryPairingError('temporary_control_host_response_invalid', 502);
        }
        return body;
      } catch (error) {
        if (typeof error?.code === 'string' && error.code.startsWith('temporary_')) throw error;
        if (signal?.aborted) throw temporaryPairingError('temporary_control_host_stopped', 503);
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw temporaryPairingError('temporary_control_host_timeout', 504);
        throw temporaryPairingError('temporary_control_host_unavailable', 503);
      }
    },
  });
}
