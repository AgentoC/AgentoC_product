import { randomBytes } from 'node:crypto';
import { buildAccountPairingProof } from './account-pairing-protocol.mjs';
import { signWithInstanceIdentity } from './instance-identity.mjs';
import { temporaryBrokerUrl } from './temporary-pairing-client.mjs';

export function accountPairingError(code, statusCode = 503) {
  const e = new Error('Account pairing could not be completed'); e.code = code; e.statusCode = statusCode; return e;
}

export function createAccountPairingClient({ baseUrl, identity, fetchImpl = globalThis.fetch, clock = Date.now, allowInsecure = false }) {
  const base = temporaryBrokerUrl(baseUrl, allowInsecure);
  return { async request(action, invitationId, payload = {}) {
    const input = { instanceId: identity.instanceId, invitationId, issuedAt: clock(), nonce: randomBytes(24).toString('hex'), payload };
    input.signature = signWithInstanceIdentity(identity, buildAccountPairingProof(action, input));
    let response;
    try { response = await fetchImpl(`${base}/v1/account-pairing/${action}`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000) }); }
    catch { throw accountPairingError('account_pairing_unavailable'); }
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > 16 * 1024) throw accountPairingError('account_pairing_response_too_large', 502);
        chunks.push(Buffer.from(value)); }
    } finally { await reader.cancel().catch(() => {}); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw accountPairingError('account_pairing_response_invalid', 502); }
    if (!response.ok) throw accountPairingError(/^account_pairing_[a-z_]+$/.test(body?.code || '') ? body.code : 'account_pairing_rejected', response.status);
    if (body?.instanceId !== identity.instanceId || body?.invitationId !== invitationId
      || !['PENDING', 'CLAIMED', 'APPROVED', 'REVOKED', 'EXPIRED'].includes(body.status)) throw accountPairingError('account_pairing_response_invalid', 502);
    return body;
  } };
}
