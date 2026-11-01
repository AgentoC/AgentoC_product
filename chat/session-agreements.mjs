const MAX_ACTIVE_SESSION_AGREEMENTS = 6;
const MAX_ACTIVE_SESSION_AGREEMENT_CHARS = 240;

function normalizeAgreementText(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= MAX_ACTIVE_SESSION_AGREEMENT_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_ACTIVE_SESSION_AGREEMENT_CHARS - 1).trimEnd()}…`;
}

export function normalizeSessionAgreements(value) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const agreements = [];

  for (const entry of value) {
    const normalized = normalizeAgreementText(entry);
    if (!normalized) continue;
    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    agreements.push(normalized);
    if (agreements.length >= MAX_ACTIVE_SESSION_AGREEMENTS) {
      break;
    }
  }

  return agreements;
}

export function buildSessionAgreementsPromptBlock(agreements = []) {
  const normalized = normalizeSessionAgreements(agreements);
  if (normalized.length === 0) return '';
  return [
    'Manager note: this session already has active working agreements. Keep them in force until the user changes or clears them.',
    ...normalized.map((entry) => `- ${entry}`),
  ].join('\n');
}
