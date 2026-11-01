const SUPPORTED_UI_LANGUAGE_VALUES = new Set(['auto', 'en', 'zh-CN']);

export const DEFAULT_UI_LANGUAGE = 'auto';

export function normalizeUiLanguagePreference(value, { allowAuto = true } = {}) {
  if (typeof value !== 'string') return allowAuto ? DEFAULT_UI_LANGUAGE : 'en';
  const normalized = value.trim();
  if (!normalized) return allowAuto ? DEFAULT_UI_LANGUAGE : 'en';
  if (normalized === 'auto') return allowAuto ? 'auto' : 'en';
  if (/^zh(?:[-_](?:cn|hans))?$/i.test(normalized)) return 'zh-CN';
  if (/^en(?:[-_].*)?$/i.test(normalized)) return 'en';
  return allowAuto ? DEFAULT_UI_LANGUAGE : 'en';
}

export function isSupportedUiLanguagePreference(value, { allowAuto = true } = {}) {
  const normalized = normalizeUiLanguagePreference(value, { allowAuto });
  return SUPPORTED_UI_LANGUAGE_VALUES.has(normalized) && (allowAuto || normalized !== 'auto');
}

export function listSupportedUiLanguagePreferences({ includeAuto = true } = {}) {
  return includeAuto
    ? ['auto', 'zh-CN', 'en']
    : ['zh-CN', 'en'];
}

// Picks the localized variant for a per-locale text catalog such as
// { "zh-CN": "...", "en": "...", "auto": "..." }. Resolution order:
// exact normalized locale → the catalog's own "auto" variant → first
// non-empty variant. Returns '' when the catalog holds no usable text.
export function pickLocalizedText(catalog, uiLanguage = '') {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return '';
  const normalized = normalizeUiLanguagePreference(uiLanguage, { allowAuto: true });
  if (!normalized || normalized === 'auto') {
    const auto = typeof catalog.auto === 'string' ? catalog.auto.trim() : '';
    if (auto) return auto;
  } else {
    const exact = typeof catalog[normalized] === 'string' ? catalog[normalized].trim() : '';
    if (exact) return exact;
  }
  for (const key of Object.keys(catalog)) {
    const value = typeof catalog[key] === 'string' ? catalog[key].trim() : '';
    if (value) return value;
  }
  return '';
}
