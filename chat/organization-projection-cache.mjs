import { BoundedLruMap } from './cache-utils.mjs';
import { registerLruOrMap } from './memory-registry.mjs';
import { cacheBudget } from '../lib/cache-budget.mjs';

// Organization projections are bounded read models. They are safe to evict
// because every value is rebuilt from the collaboration database, while a
// short TTL covers mutation paths that pre-date the invalidation publisher.
const ORGANIZATION_PROJECTION_CACHE_MAX_ENTRIES = 32;
const ORGANIZATION_PROJECTION_CACHE_TTL_MS = 1000;

function approximateJsonBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return 0; }
}

export const organizationProjectionCache = new BoundedLruMap({
  maxEntries: ORGANIZATION_PROJECTION_CACHE_MAX_ENTRIES,
  maxBytes: cacheBudget('organization.projection', 0.5),
  ttlMs: ORGANIZATION_PROJECTION_CACHE_TTL_MS,
  bytesOf: approximateJsonBytes,
});
export const organizationProjectionInflight = new Map();
const organizationProjectionGenerations = new Map();
let globalProjectionGeneration = 0;

export function organizationProjectionGeneration(organizationId = '') {
  const normalized = typeof organizationId === 'string' ? organizationId.trim() : '';
  return `${globalProjectionGeneration}:${organizationProjectionGenerations.get(normalized) || 0}`;
}

registerLruOrMap('organization.projection', organizationProjectionCache, { kind: 'projection' });

export function invalidateOrganizationProjectionCache(organizationId = '') {
  const normalized = typeof organizationId === 'string' ? organizationId.trim() : '';
  if (!normalized) {
    globalProjectionGeneration += 1;
    organizationProjectionCache.clear();
    for (const key of organizationProjectionInflight.keys()) organizationProjectionInflight.delete(key);
    return;
  }
  organizationProjectionGenerations.set(normalized, (organizationProjectionGenerations.get(normalized) || 0) + 1);
  organizationProjectionCache.deleteMatching((key) => String(key).startsWith(`${normalized}|`));
  for (const key of organizationProjectionInflight.keys()) {
    if (String(key).startsWith(`${normalized}|`)) organizationProjectionInflight.delete(key);
  }
}

export function resetOrganizationProjectionCacheForTest() {
  organizationProjectionCache.clear();
  organizationProjectionInflight.clear();
  organizationProjectionGenerations.clear();
  globalProjectionGeneration += 1;
}
