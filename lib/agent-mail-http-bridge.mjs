export function normalizeIp(value) {
  const text = String(value || '').trim();
  return text.startsWith('::ffff:') ? text.slice('::ffff:'.length) : text;
}

export function extractBearerToken(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  const match = normalized.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : normalized;
}

export function matchesWebhookToken(value, expectedToken) {
  const expected = String(expectedToken || '').trim();
  if (!expected) return false;
  return extractBearerToken(value) === expected;
}
