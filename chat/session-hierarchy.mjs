// Session hierarchy is the user-facing projection of session delegation.
// Organization roles remain in sessionClass; user-visible forks preserve their
// fork lineage but inherit the source session's hierarchy projection instead
// of becoming delegation children.

const SESSION_CLASSES = new Set(['ROOT_LEADERSHIP', 'MANAGER', 'WORKER', 'REVIEWER']);
const MAX_LINEAGE_DEPTH = 64;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedClass(value) {
  const normalized = text(value).toUpperCase();
  return SESSION_CLASSES.has(normalized) ? normalized : '';
}

function explicitRootSessionId(meta) {
  return text(meta?.organizationRootSessionId) || text(meta?.rootSessionId);
}

export function getSessionParentId(meta = {}) {
  const ownId = text(meta?.id);
  const forkSourceId = text(meta?.forkedFromSessionId);
  const candidates = [
    meta?.parentSessionId,
    meta?.delegatedFromSessionId,
    meta?.controllerSessionId,
  ];
  return candidates
    .map(text)
    .find((candidate) => candidate && candidate !== ownId && candidate !== forkSourceId) || '';
}

function categoryFor(meta, parentSessionId, resolvedRootSessionId) {
  const sessionClass = normalizedClass(meta?.sessionClass);
  if (text(meta?.sessionPlane).toLowerCase() === 'system' || text(meta?.internalRole)) return 'system';
  if (sessionClass === 'MANAGER') return 'manager';
  if (sessionClass === 'WORKER') return 'worker';
  if (sessionClass === 'REVIEWER') return 'reviewer';
  if (parentSessionId) return 'delegated';
  if (resolvedRootSessionId && resolvedRootSessionId !== text(meta?.id)) return 'detached';
  return 'root';
}

function fallbackLevel(meta, hasParent) {
  if (!hasParent) return 0;
  const candidates = [meta?.hierarchyLevel, meta?.delegationDepth, meta?.depth];
  for (const value of candidates) {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value || ''), 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed > 0 ? parsed : 1;
  }
  return 1;
}

function makeProjection(meta, {
  parentSessionId = '',
  rootSessionId = '',
  level = 0,
  category: categoryOverride = '',
  isRoot: isRootOverride,
  cycle = false,
} = {}) {
  const id = text(meta?.id);
  const explicitRoot = explicitRootSessionId(meta);
  const resolvedRoot = rootSessionId || explicitRoot || id;
  const isRoot = typeof isRootOverride === 'boolean'
    ? isRootOverride
    : (!parentSessionId && resolvedRoot === id);
  const category = categoryOverride || categoryFor(meta, parentSessionId, resolvedRoot);
  return {
    level,
    category,
    rootSessionId: resolvedRoot || null,
    parentSessionId: parentSessionId || null,
    isRoot,
    ...(cycle ? { invalid: 'cycle' } : {}),
  };
}

export function buildSessionHierarchyIndex(metas = []) {
  const byId = new Map(
    (Array.isArray(metas) ? metas : [])
      .filter((meta) => text(meta?.id))
      .map((meta) => [text(meta.id), meta]),
  );
  const projections = new Map();
  const visiting = new Set();

  function visit(meta) {
    const id = text(meta?.id);
    if (!id) return makeProjection(meta);
    if (projections.has(id)) return projections.get(id);
    if (visiting.has(id)) {
      const cycleProjection = makeProjection(meta, {
        parentSessionId: getSessionParentId(meta),
        rootSessionId: explicitRootSessionId(meta) || id,
        level: fallbackLevel(meta, true),
        cycle: true,
      });
      projections.set(id, cycleProjection);
      return cycleProjection;
    }

    visiting.add(id);
    const parentSessionId = getSessionParentId(meta);
    const parent = parentSessionId ? byId.get(parentSessionId) : null;
    const forkSourceId = text(meta?.forkedFromSessionId);
    const forkSource = forkSourceId ? byId.get(forkSourceId) : null;
    let projection;
    if (forkSource && forkSource.id !== id && !visiting.has(forkSource.id)) {
      // A fork is a new user-addressable workstream. Keep forkedFromSessionId
      // as lineage metadata, but copy the source's hierarchy classification so
      // a fork of a root remains a root for root-only surfaces.
      const sourceProjection = visit(forkSource);
      projection = makeProjection(meta, {
        rootSessionId: sourceProjection.rootSessionId || explicitRootSessionId(meta) || id,
        level: sourceProjection.level,
        category: sourceProjection.category,
        isRoot: sourceProjection.isRoot,
        cycle: sourceProjection.invalid === 'cycle',
      });
    } else if (forkSourceId && !parentSessionId) {
      // Keep malformed/orphaned historical fork records addressable as roots;
      // there is no source projection available to inherit from.
      projection = makeProjection(meta, {
        rootSessionId: explicitRootSessionId(meta) || id,
        level: fallbackLevel(meta, false),
        category: 'root',
        isRoot: true,
      });
    } else if (parent && parent.id !== id && !visiting.has(parent.id)) {
      const parentProjection = visit(parent);
      projection = makeProjection(meta, {
        parentSessionId,
        rootSessionId: parentProjection.rootSessionId || explicitRootSessionId(meta) || parent.id,
        level: Math.min(MAX_LINEAGE_DEPTH, parentProjection.level + 1),
        cycle: parentProjection.invalid === 'cycle',
      });
    } else {
      projection = makeProjection(meta, {
        parentSessionId,
        rootSessionId: explicitRootSessionId(meta) || (parentSessionId ? parentSessionId : id),
        level: fallbackLevel(meta, !!parentSessionId),
        cycle: !!parentSessionId && (!parent || parent.id === id),
      });
    }
    visiting.delete(id);
    projections.set(id, projection);
    return projection;
  }

  for (const meta of byId.values()) visit(meta);
  return projections;
}

export function buildSessionHierarchyProjection(meta = {}, hierarchyIndex = null) {
  const id = text(meta?.id);
  const forkSourceId = text(meta?.forkedFromSessionId);
  if (forkSourceId && !getSessionParentId(meta)) {
    // Without the complete index there is no source projection to copy. Keep
    // a fork addressable as a root rather than reclassifying its fork lineage
    // as delegation; indexed projections above provide the exact inheritance.
    return hierarchyIndex?.get(id) || makeProjection(meta, {
      rootSessionId: explicitRootSessionId(meta) || id,
      level: fallbackLevel(meta, false),
      category: 'root',
      isRoot: true,
    });
  }
  return hierarchyIndex?.get(id) || makeProjection(meta, {
    parentSessionId: getSessionParentId(meta),
    rootSessionId: explicitRootSessionId(meta) || id,
    level: fallbackLevel(meta, !!getSessionParentId(meta)),
  });
}

export function isRootSessionMeta(meta = {}, hierarchyIndex = null) {
  const projection = buildSessionHierarchyProjection(meta, hierarchyIndex);
  return projection.isRoot === true && projection.category === 'root';
}
