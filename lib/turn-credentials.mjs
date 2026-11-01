// Cloudflare Realtime TURN credentials are minted through Cloudflare's
// generate-ice-servers API. A TURN key ID and API token are management
// credentials, not RFC 5766 REST username/password credentials; clients must
// receive the short-lived ICE credentials returned by that API.
//
// This module stays free of network I/O. Only infrastructure/turn-broker reads
// the Cloudflare management credentials and calls the provider API.

export const CLOUDFLARE_TURN_CREDENTIALS_API_ORIGIN = 'https://rtc.live.cloudflare.com';
export const TURN_CREDENTIAL_DEFAULT_TTL_MS = 30 * 60 * 1000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlaceholder(value) {
  return /^(placeholder|changeme|test|dummy)$/i.test(value);
}

/**
 * Resolve the dedicated broker's Cloudflare API credentials. The legacy names
 * are accepted only for a safe in-place migration from existing deployments.
 */
export function resolveCloudflareTurnCredentialSource({
  turnKeyId,
  apiToken,
  // Backward-compatible aliases used by the original broker deployment.
  keyName,
  secret,
} = {}) {
  const resolvedKeyId = trimString(turnKeyId) || trimString(keyName);
  const resolvedApiToken = trimString(apiToken) || trimString(secret);
  if (!resolvedKeyId || !resolvedApiToken || resolvedApiToken.length < 16) return null;
  if (isPlaceholder(resolvedKeyId) || isPlaceholder(resolvedApiToken)) return null;
  return { turnKeyId: resolvedKeyId, apiToken: resolvedApiToken };
}

/** Build the provider endpoint without exposing a token in the URL. */
export function cloudflareTurnCredentialsUrl({ turnKeyId } = {}) {
  const normalizedKeyId = trimString(turnKeyId);
  if (!normalizedKeyId) return '';
  return `${CLOUDFLARE_TURN_CREDENTIALS_API_ORIGIN}/v1/turn/keys/${encodeURIComponent(normalizedKeyId)}/credentials/generate-ice-servers`;
}

/**
 * Convert Cloudflare's `iceServers` response to the broker's established
 * one-URL-per-row contract. The broker gates TURN-over-TLS URLs behind an
 * explicit client capability so older Android builds keep the prior shape.
 */
export function normalizeCloudflareTurnIceServers(payload) {
  const sourceServers = Array.isArray(payload?.iceServers) ? payload.iceServers : [];
  const normalized = [];
  for (const source of sourceServers) {
    const username = trimString(source?.username);
    const password = trimString(source?.credential) || trimString(source?.password);
    if (!username || !password) continue;
    const urls = Array.isArray(source?.urls) ? source.urls : [source?.urls];
    for (const value of urls) {
      const url = trimString(value);
      if (!/^turns?:/i.test(url)) continue;
      normalized.push({ urls: url, username, password });
    }
  }
  return normalized;
}
