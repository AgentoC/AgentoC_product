// Shared Agent discovery boundary for Root Leadership and Durable Collaboration.
// A single bad Agent/tool must not hide every other selectable Agent.
import { createHash } from 'crypto';
import { listApps } from './apps.mjs';
import { buildAgentCapabilityProfile } from './agent-capability-registry.mjs';
import { getToolDefinitionAsync } from '../lib/tools.mjs';

function text(value, max = 240) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function errorFact(error, app = {}) {
  const code = text(error?.code, 120) || 'AGENT_CAPABILITY_BUILD_FAILED';
  return {
    agentId: text(app?.id, 200),
    name: text(app?.name, 200),
    code,
    reason: 'capability_profile_unavailable',
    message: 'Agent capability facts could not be built for this Agent',
  };
}

function profileForCatalog(profile) {
  return {
    ...profile,
    selectable: true,
    unavailableReasons: [],
  };
}

export async function buildAgentCapabilityCatalog({
  apps = null,
  getApps = listApps,
  getTool = getToolDefinitionAsync,
  buildProfile = buildAgentCapabilityProfile,
} = {}) {
  let source;
  const errors = [];
  try {
    source = Array.isArray(apps) ? apps : await getApps();
  } catch (error) {
    errors.push({
      agentId: '',
      name: '',
      code: text(error?.code, 120) || 'AGENT_CATALOG_SOURCE_FAILED',
      reason: 'catalog_source_unavailable',
      message: 'Agent catalog source could not be read',
    });
    source = [];
  }

  const candidates = (Array.isArray(source) ? source : [])
    .filter((app) => app?.builtin !== true);
  const settled = await Promise.allSettled(candidates.map(async (app) => {
    const agentId = text(app?.id, 200);
    if (!agentId) {
      const error = new Error('Agent id is required');
      error.code = 'AGENT_ID_MISSING';
      throw error;
    }
    const toolDefinition = app?.tool && typeof getTool === 'function'
      ? await getTool(app.tool)
      : null;
    return profileForCatalog(await buildProfile(app, { toolDefinition }));
  }));

  const agents = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value?.agentId) {
      agents.push(result.value);
    } else {
      errors.push(errorFact(result.reason, candidates[index]));
    }
  });
  agents.sort((left, right) => left.agentId.localeCompare(right.agentId));
  errors.sort((left, right) => `${left.agentId}:${left.code}`.localeCompare(`${right.agentId}:${right.code}`));
  const state = errors.length > 0 ? 'degraded' : (agents.length > 0 ? 'ready' : 'empty');
  const revision = `sha256:${createHash('sha256').update(canonical({
    state,
    agents,
    errors,
  }), 'utf8').digest('hex')}`;
  return {
    schemaVersion: 1,
    state,
    revision,
    agents,
    errors,
  };
}

export function catalogProfiles(catalog) {
  return Array.isArray(catalog?.agents)
    ? catalog.agents.filter((agent) => agent?.selectable !== false && agent?.agentId)
    : [];
}
