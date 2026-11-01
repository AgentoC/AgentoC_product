// Organization projection invalidation is a small server-to-client hint. The
// payload carries only the version tuple; clients re-fetch the owner-only
// projection over HTTP and use ETag for the stable read path.
import { ORG_PROJECTION_V1_ENABLED, ORG_PROJECTION_V2_ENABLED } from '../lib/config.mjs';
import { broadcastOwners } from './ws-clients.mjs';
import { invalidateOrganizationProjectionCache } from './organization-projection-cache.mjs';

const pending = new Map();
let flushTimer = null;

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function integer(value, fallback = 0) { return Number.isInteger(value) ? value : fallback; }

async function flush() {
  flushTimer = null;
  const entries = [...pending.values()];
  pending.clear();
  if (entries.length === 0 || (!ORG_PROJECTION_V1_ENABLED && !ORG_PROJECTION_V2_ENABLED)) return;
  const { buildOrganizationProjection } = await import('./organization-projection.mjs');
  for (const entry of entries) {
    try {
      const projection = await buildOrganizationProjection(entry.organizationId, { version: ORG_PROJECTION_V2_ENABLED ? 2 : 1 });
      if (!projection) continue;
      broadcastOwners({
        type: 'organization_invalidated',
        organizationId: entry.organizationId,
        eventId: projection.asOf?.eventId || entry.eventId || 0,
        revision: projection.asOf?.revision || entry.revision || 0,
        progressEpoch: projection.asOf?.progressEpoch ?? entry.progressEpoch ?? 0,
        projectionDigest: projection.asOf?.projectionDigest || projection.digest || null,
      });
    } catch (error) {
      console.warn(`[organization] projection invalidation failed: ${error.message}`);
    }
  }
}

export function publishOrganizationInvalidation({ organizationId, eventId = 0, revision = 0, progressEpoch = 0 } = {}) {
  const orgId = text(organizationId);
  if (!orgId || (!ORG_PROJECTION_V1_ENABLED && !ORG_PROJECTION_V2_ENABLED)) return false;
  invalidateOrganizationProjectionCache(orgId);
  const previous = pending.get(orgId) || {};
  pending.set(orgId, {
    organizationId: orgId,
    eventId: Math.max(integer(previous.eventId), integer(eventId)),
    revision: Math.max(integer(previous.revision), integer(revision)),
    progressEpoch: Math.max(integer(previous.progressEpoch), integer(progressEpoch)),
  });
  if (!flushTimer) flushTimer = setTimeout(() => { void flush(); }, 20);
  return true;
}

export function __resetOrganizationInvalidationForTest() {
  pending.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}
