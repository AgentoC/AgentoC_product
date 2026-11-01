// Shared, non-secret Harness compatibility policy. Accounts ships the same
// defaults and may override them from its central policy file; instances use
// the response as a bounded runtime policy, never as an installation command.

import {
  HARNESS_VERSION_CONTRACTS,
  HARNESS_VERSION_CATALOG_REVISION,
} from './harness-version-catalog.mjs';

export const HARNESS_POLICY_SCHEMA_VERSION = 2;
export const HARNESS_POLICY_CATALOG_REVISION = HARNESS_VERSION_CATALOG_REVISION;

export const DEFAULT_HARNESS_POLICY = Object.freeze(Object.fromEntries(
  Object.entries(HARNESS_VERSION_CONTRACTS).map(([id, value]) => [id, Object.freeze({
    ...(value.minimumVersion ? { minimumVersion: value.minimumVersion } : {}),
    targetVersion: value.targetVersion,
    ...(value.serviceRuntimeMinimumVersion ? { serviceRuntimeMinimumVersion: value.serviceRuntimeMinimumVersion } : {}),
  })]),
));

function text(value) { return typeof value === 'string' ? value.trim() : ''; }

export function normalizeHarnessPolicy(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const result = {};
  for (const [id, defaults] of Object.entries(DEFAULT_HARNESS_POLICY)) {
    const override = source[id] && typeof source[id] === 'object' ? source[id] : {};
    const minimumVersion = text(override.minimumVersion) || defaults.minimumVersion || '';
    const targetVersion = text(override.targetVersion) || defaults.targetVersion || '';
    result[id] = {
      ...(minimumVersion ? { minimumVersion } : {}),
      ...(targetVersion ? { targetVersion } : {}),
      ...(text(override.serviceRuntimeMinimumVersion)
        ? { serviceRuntimeMinimumVersion: text(override.serviceRuntimeMinimumVersion) }
        : (defaults.serviceRuntimeMinimumVersion ? { serviceRuntimeMinimumVersion: defaults.serviceRuntimeMinimumVersion } : {})),
    };
  }
  return result;
}

export function buildHarnessPolicyDocument(overrides = {}, { updatedAt = '', revision = '' } = {}) {
  const policy = normalizeHarnessPolicy(overrides);
  return {
    schemaVersion: HARNESS_POLICY_SCHEMA_VERSION,
    catalogRevision: HARNESS_POLICY_CATALOG_REVISION,
    revision: text(revision) || 'builtin-v2',
    updatedAt: text(updatedAt) || null,
    policies: policy,
  };
}
