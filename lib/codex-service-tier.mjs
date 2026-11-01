export const CODEX_SERVICE_TIER_STANDARD = 'standard';
export const CODEX_SERVICE_TIER_FAST = 'fast';
export const CODEX_SERVICE_TIER_OPTIONS = [
  CODEX_SERVICE_TIER_STANDARD,
  CODEX_SERVICE_TIER_FAST,
];

export function normalizeCodexServiceTier(value) {
  return String(value || '').trim().toLowerCase() === CODEX_SERVICE_TIER_FAST
    ? CODEX_SERVICE_TIER_FAST
    : CODEX_SERVICE_TIER_STANDARD;
}

export function resolveCodexServiceTier(value, { official = false } = {}) {
  return official && normalizeCodexServiceTier(value) === CODEX_SERVICE_TIER_FAST
    ? CODEX_SERVICE_TIER_FAST
    : CODEX_SERVICE_TIER_STANDARD;
}

export function codexServiceTierOptions({ official = false } = {}) {
  return official
    ? [...CODEX_SERVICE_TIER_OPTIONS]
    : [CODEX_SERVICE_TIER_STANDARD];
}
