// S16 capability-first Agent resolver and delegation proof. This module is
// pure apart from optional AgentTemplate lookup injected by callers.
import {
  DEFAULT_MAX_CHILDREN,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_DEPTH,
  getAgentCapabilityProfile,
  normalizeCapabilityProfile,
  profileAllowsAgent,
} from './agent-capability-registry.mjs';
import {
  ORGANIZATION_RUNTIME_TOOLS,
  resolveRuntimeSelection,
  runtimePolicyHasConstraints,
} from './organization-runtime-selection.mjs';

export const ORG_AGENT_NOT_ALLOWED = 'ORG_AGENT_NOT_ALLOWED';
export const ORG_DELEGATION_NOT_ALLOWED = 'ORG_DELEGATION_NOT_ALLOWED';
export const ORG_CAPABILITY_ESCALATION = 'ORG_CAPABILITY_ESCALATION';
export const ORG_MAX_DEPTH_EXCEEDED = 'ORG_MAX_DEPTH_EXCEEDED';
export const ORG_OPERATION_CONFLICT = 'ORG_OPERATION_CONFLICT';

const ACCESS_RANK = Object.freeze({ none: 0, read_only: 1, writer: 2 });
const ISOLATION_RANK = Object.freeze({ shared: 0, worktree: 1, container: 2 });

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter(Boolean))].sort();
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function integer(value, fallback, max = 1_000_000) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? Math.min(number, max) : fallback;
}

function fail(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}

function subset(requested, parent) {
  const parentSet = new Set(list(parent));
  return list(requested).every((value) => parentSet.has(value));
}

function normalizePath(value) {
  const path = text(value).replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  if (path === '..' || path.startsWith('../') || path.includes('/../')) return null;
  return path;
}

function pathWithin(child, parent) {
  const childPath = normalizePath(child);
  const parentPath = normalizePath(parent);
  if (!childPath || !parentPath) return false;
  return childPath === parentPath || childPath.startsWith(`${parentPath === '/' ? '' : parentPath}/`);
}

function pathsWithin(requested, parent) {
  const parents = list(parent);
  return list(requested).every((path) => parents.some((base) => pathWithin(path, base)));
}

function ceiling(parentMode, requestedMode) {
  const parent = text(parentMode).toLowerCase() || 'read_only';
  const requested = text(requestedMode).toLowerCase() || parent;
  return Object.hasOwn(ACCESS_RANK, requested)
    && Object.hasOwn(ACCESS_RANK, parent)
    && ACCESS_RANK[requested] <= ACCESS_RANK[parent];
}

function stableProfile(candidate) {
  return normalizeCapabilityProfile(candidate?.capabilityProfile || candidate?.profile || candidate);
}

export async function resolveDelegatedRuntimeSelection({
  request = {},
  parentProfile = {},
  parentGrant = {},
  childProfile = {},
  getModels,
  getTool,
  getProviders,
} = {}) {
  return resolveRuntimeSelection({
    requested: request.runtime || request.runtimeSelection || {},
    profile: childProfile,
    parentGrant: {
      ...parentGrant,
      ...(parentGrant.runtimePolicy || !parentProfile?.runtimePolicy
        ? {}
        : { runtimePolicy: parentProfile.runtimePolicy }),
    },
    ...(typeof getModels === 'function' ? { getModels } : {}),
    ...(typeof getTool === 'function' ? { getTool } : {}),
    ...(typeof getProviders === 'function' ? { getProviders } : {}),
  });
}

export function proveNoCapabilityEscalation({ parentProfile, parentGrant = {}, request = {}, childProfile, depth = 0 } = {}) {
  const parent = normalizeCapabilityProfile({ ...object(parentProfile), ...object(parentGrant) });
  const child = normalizeCapabilityProfile(childProfile || request);
  const askedCapabilities = list(request.capabilities || request.allowedCapabilities || child.capabilities).map((value) => value.toLowerCase());
  const parentCapabilities = list(parentGrant.allowedCapabilities || parent.capabilities).map((value) => value.toLowerCase());
  if (!subset(askedCapabilities, parentCapabilities) || !subset(child.capabilities, parentCapabilities)) {
    throw fail(ORG_CAPABILITY_ESCALATION, 'delegation requests a capability outside the parent grant', 403);
  }

  const requestedPaths = list(request.writablePaths || child.writablePaths);
  const parentPaths = list(parentGrant.writablePaths || parent.writablePaths);
  if (!pathsWithin(requestedPaths, parentPaths)) {
    throw fail(ORG_CAPABILITY_ESCALATION, 'delegation expands writablePaths beyond the parent scope', 403);
  }
  const requestedWorkspace = text(request.workspaceScope || child.workspaceScope);
  const parentWorkspace = text(parentGrant.workspaceScope || parent.workspaceScope);
  if (requestedWorkspace && (!parentWorkspace || !pathWithin(requestedWorkspace, parentWorkspace))) {
    throw fail(ORG_CAPABILITY_ESCALATION, 'delegation expands workspaceScope beyond the parent scope', 403);
  }
  if (text(request.projectId || child.projectId) && text(request.projectId || child.projectId) !== text(parentGrant.projectId || parent.projectId)) {
    throw fail(ORG_CAPABILITY_ESCALATION, 'delegation changes project identity', 403);
  }
  const requestedAccessMode = text(request.accessMode || child.accessMode) || text(parentGrant.accessMode || parent.accessMode);
  if (!ceiling(parentGrant.accessMode || parent.accessMode, requestedAccessMode)) {
    throw fail(ORG_CAPABILITY_ESCALATION, 'delegation raises accessMode', 403);
  }
  const parentIsolation = text(parentGrant.executionIsolation || parent.executionIsolation) || 'shared';
  const requestedIsolation = text(request.executionIsolation || child.executionIsolation) || parentIsolation;
  if (!Object.hasOwn(ISOLATION_RANK, requestedIsolation)
    || !Object.hasOwn(ISOLATION_RANK, parentIsolation)
    || requestedIsolation !== parentIsolation) {
    throw fail(ORG_CAPABILITY_ESCALATION, 'delegation changes execution isolation', 403);
  }
  const remainingDepth = Math.max(0, integer(parentGrant.maxDepth ?? parent.maxDepth, DEFAULT_MAX_DEPTH) - 1);
  const requestedDepth = integer(request.maxDepth ?? child.maxDepth, remainingDepth);
  if (depth + 1 > integer(parentGrant.maxDepth ?? parent.maxDepth, DEFAULT_MAX_DEPTH)
    || requestedDepth > remainingDepth) {
    throw fail(ORG_MAX_DEPTH_EXCEEDED, 'delegation exceeds the remaining organization depth', 422);
  }

  const parentChildren = integer(parentGrant.maxChildren ?? parent.maxChildren, DEFAULT_MAX_CHILDREN);
  const parentConcurrent = integer(parentGrant.maxConcurrent ?? parent.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  const requestedChildren = integer(request.maxChildren ?? child.maxChildren, parentChildren);
  const requestedConcurrent = integer(request.maxConcurrent ?? child.maxConcurrent, parentConcurrent);
  if (requestedChildren > parentChildren || requestedConcurrent > parentConcurrent) {
    throw fail(ORG_CAPABILITY_ESCALATION, 'delegation raises child or concurrency quota', 403);
  }

  const allowedCapabilities = list(askedCapabilities.length > 0 ? askedCapabilities : parentCapabilities);
  const effective = {
    allowedCapabilities,
    writablePaths: requestedPaths,
    workspaceScope: requestedWorkspace || parentWorkspace,
    projectId: text(parentGrant.projectId || parent.projectId),
    accessMode: requestedAccessMode,
    executionIsolation: requestedIsolation,
    maxDepth: requestedDepth,
    maxChildren: Math.min(parentChildren, requestedChildren),
    maxConcurrent: Math.min(parentConcurrent, requestedConcurrent),
    canDelegate: child.role === 'manager' && parent.canDelegate === true && child.canDelegate === true,
  };
  if (['worker', 'specialist', 'reviewer'].includes(child.role)) effective.canDelegate = false;
  return { effective, proof: { capabilitySubset: true, scopeSubset: true, accessModeCeiling: true, quotaSubset: true, depthBound: true } };
}

export async function resolveAgentCandidates(request = {}, {
  profiles = [],
  parentProfile = null,
  parentGrant = {},
  depth = 0,
  getAgent,
  getTool,
  getModels,
  getProviders,
} = {}) {
  const requestedCapabilities = list(request.capabilities || request.allowedCapabilities).map((value) => value.toLowerCase());
  const requestedRole = text(request.role).toLowerCase();
  const requestedTool = text(request.toolProfile || request.toolId);
  const requestedSkills = list(request.skillProfiles || request.skills);
  const source = profiles.length > 0
    ? profiles
    : list(request.agentIds).map((agentId) => ({ agentId }));
  const resolved = [];
  for (const candidate of source) {
    const profile = candidate?.capabilities && candidate?.agentId
      ? stableProfile(candidate)
      : candidate?.capabilityProfile
        ? stableProfile(candidate)
        : candidate?.agentId
          ? await getAgentCapabilityProfile(candidate.agentId, { getAgent, getTool })
          : stableProfile(candidate);
    if (!profile?.agentId) continue;
    if (requestedRole && profile.role !== requestedRole) continue;
    if (requestedCapabilities.length > 0 && !subset(requestedCapabilities, profile.capabilities)) continue;
    if (requestedTool && !profile.toolProfiles.includes(requestedTool)) continue;
    if (requestedSkills.length > 0 && !subset(requestedSkills, profile.skillProfiles)) continue;
    if (parentProfile && !profileAllowsAgent(parentProfile, profile.agentId, profile.role)) continue;
    try {
      const proof = parentProfile
        ? proveNoCapabilityEscalation({ parentProfile, parentGrant, request, childProfile: profile, depth })
        : { effective: profile, proof: null };
      const requestedRuntime = request.runtime || request.runtimeSelection || {};
      const runtimePolicy = profile.runtimePolicy || {};
      const runtimeTool = profile.runtimeProfile?.toolId || profile.toolId || '';
      const shouldResolveRuntime = Object.keys(requestedRuntime).length > 0
        || ORGANIZATION_RUNTIME_TOOLS.includes(runtimeTool)
        || runtimePolicyHasConstraints(runtimePolicy);
      const runtime = shouldResolveRuntime
        ? await resolveDelegatedRuntimeSelection({
          request,
          parentProfile,
          parentGrant,
          childProfile: profile,
          getModels,
          getTool,
          getProviders,
        })
        : null;
      const capabilityCoverage = requestedCapabilities.filter((value) => profile.capabilities.includes(value)).length;
      const exactTool = requestedTool && profile.toolProfiles.includes(requestedTool) ? 1 : 0;
      const exactRole = requestedRole && profile.role === requestedRole ? 1 : 0;
      resolved.push({ profile, effective: proof.effective, proof: proof.proof, runtime, score: [capabilityCoverage, exactTool, exactRole] });
    } catch (error) {
      if (error.code === ORG_MAX_DEPTH_EXCEEDED || error.code === ORG_CAPABILITY_ESCALATION) continue;
    }
  }
  resolved.sort((left, right) => {
    for (let index = 0; index < left.score.length; index += 1) {
      if (left.score[index] !== right.score[index]) return right.score[index] - left.score[index];
    }
    return left.profile.agentId.localeCompare(right.profile.agentId);
  });
  return resolved;
}

export async function resolveAgent(request = {}, options = {}) {
  const parentProfile = options.parentProfile ? normalizeCapabilityProfile(options.parentProfile) : null;
  if (parentProfile?.canDelegate !== true) {
    throw fail(ORG_DELEGATION_NOT_ALLOWED, 'the parent role is not allowed to delegate', 403);
  }
  const candidates = await resolveAgentCandidates(request, { ...options, parentProfile });
  if (candidates.length === 0) {
    throw fail(ORG_AGENT_NOT_ALLOWED, 'no allowed Agent satisfies the requested capability profile', 422);
  }
  return candidates[0];
}

export function assertDelegationAllowed(parentProfile, { childCount = 0, concurrentCount = 0, depth = 0 } = {}) {
  const parent = normalizeCapabilityProfile(parentProfile);
  if (!parent.canDelegate || !['manager'].includes(parent.role)) {
    throw fail(ORG_DELEGATION_NOT_ALLOWED, 'only a delegating manager may create child roles', 403);
  }
  if (depth >= DEFAULT_MAX_DEPTH || depth >= parent.maxDepth) {
    throw fail(ORG_MAX_DEPTH_EXCEEDED, 'organization delegation depth exceeded', 422);
  }
  if (childCount >= parent.maxChildren || concurrentCount >= parent.maxConcurrent) {
    throw fail(ORG_OPERATION_CONFLICT, 'organization child or concurrent quota is exhausted', 409);
  }
  return true;
}
