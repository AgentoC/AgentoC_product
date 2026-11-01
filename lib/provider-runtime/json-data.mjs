// V8 JSON errors contain excerpts. Provider files can contain credentials;
// expose only a static filename and a repair code, never the parsed input.
export function parseProviderDataJson(text, fileName) {
  try {
    const value = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-root');
    return value;
  } catch {
    throw Object.assign(new Error(`PROVIDER_DATA_CORRUPT: ${fileName} is damaged. Repair the local provider data before signing in; no credential contents are included.`), {
      code: 'PROVIDER_DATA_CORRUPT', statusCode: 409,
    });
  }
}

export function assertProviderSyncHistory(state) {
  if (state?.recoveryRequired === true) {
    throw Object.assign(new Error('Provider sync is paused: local ledger history was damaged and requires reconciliation with a trusted current source.'), {
      code: 'PROVIDER_SYNC_RECOVERY_REQUIRED', statusCode: 409,
    });
  }
}
