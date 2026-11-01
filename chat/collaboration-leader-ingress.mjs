// Controlled Root Leadership ingress for Durable Collaboration.
//
// The provider may reason in natural language, but only the marked JSON
// envelope below crosses into the Runtime. Validation, policy resolution,
// idempotency and dispatch remain Runtime responsibilities; this module never
// creates Sessions directly and never treats a proposed plan as execution.
import { COLLABORATION_LEADER_ENABLED } from '../lib/config.mjs';
import { buildAgentCapabilityCatalog, catalogProfiles } from './agent-capability-catalog.mjs';
import { getToolDefinitionAsync } from '../lib/tools.mjs';
import {
  COLLABORATION_PLAN_END,
  COLLABORATION_PLAN_START,
} from './orchestration-markers.mjs';
export { COLLABORATION_PLAN_END, COLLABORATION_PLAN_START };
import {
  buildOrganizationCapabilityPrompt,
  getOrganizationRuntimeCapabilities,
} from './organization-runtime-capabilities.mjs';
import { buildOrganizationRuntimeCatalog } from './organization-runtime-selection.mjs';
import {
  dispatchValidatedCollaborationPlan,
  validateCollaborationPlanTool,
} from './orchestration-tools.mjs';

export const COLLABORATION_LEADER_DISABLED = 'COLLABORATION_LEADER_DISABLED';
export const COLLABORATION_PLAN_NOT_FOUND = 'COLLABORATION_PLAN_NOT_FOUND';
export const COLLABORATION_PLAN_REJECTED = 'COLLABORATION_PLAN_REJECTED';

const MAX_PLAN_BYTES = 128 * 1024;
const MAX_IDEMPOTENCY_KEY = 200;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function text(value, max = 4000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isRootLeadershipSession(session) {
  return session?.sessionClass === 'ROOT_LEADERSHIP'
    && (session?.sessionPlane || 'user') === 'user'
    && session?.userAddressable !== false
    && !text(session?.delegatedFromSessionId)
    && !text(session?.parentSessionId)
    && !session?.visitorId
    && session?.sourceId !== 'maintenance';
}

function stripJsonFence(value) {
  const source = text(value, MAX_PLAN_BYTES);
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(source);
  return match ? match[1].trim() : source;
}

export function extractCollaborationPlan(assistantText) {
  const source = typeof assistantText === 'string' ? assistantText : '';
  const lower = source.toLowerCase();
  const startMarker = COLLABORATION_PLAN_START.toLowerCase();
  const endMarker = COLLABORATION_PLAN_END.toLowerCase();
  const first = lower.indexOf(startMarker);
  if (first < 0) return null;
  const second = lower.indexOf(startMarker, first + startMarker.length);
  if (second >= 0) throw Object.assign(new Error('multiple collaboration plan blocks are not allowed'), {
    code: COLLABORATION_PLAN_REJECTED,
    reason: 'multiple_blocks',
  });
  const payloadStart = first + startMarker.length;
  const end = lower.indexOf(endMarker, payloadStart);
  if (end < 0) throw Object.assign(new Error('collaboration plan end marker is missing'), {
    code: COLLABORATION_PLAN_REJECTED,
    reason: 'missing_end_marker',
  });
  const raw = source.slice(payloadStart, end).trim();
  if (!raw) throw Object.assign(new Error('collaboration plan payload is empty'), {
    code: COLLABORATION_PLAN_REJECTED,
    reason: 'empty_payload',
  });
  if (Buffer.byteLength(raw, 'utf8') > MAX_PLAN_BYTES) {
    throw Object.assign(new Error('collaboration plan payload is too large'), {
      code: COLLABORATION_PLAN_REJECTED,
      reason: 'payload_too_large',
    });
  }
  try {
    const parsed = JSON.parse(stripJsonFence(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    return parsed;
  } catch {
    throw Object.assign(new Error('collaboration plan payload is not valid JSON'), {
      code: COLLABORATION_PLAN_REJECTED,
      reason: 'invalid_json',
    });
  }
}

function normalizePlanEnvelope(payload) {
  const source = object(payload);
  const rawKey = typeof source.idempotencyKey === 'string' ? source.idempotencyKey.trim() : '';
  const key = rawKey;
  if (!key || key.length > MAX_IDEMPOTENCY_KEY || !SAFE_IDEMPOTENCY_KEY.test(key)) {
    throw Object.assign(new Error('collaboration plan requires a bounded idempotencyKey'), {
      code: COLLABORATION_PLAN_REJECTED,
      reason: 'idempotency_key_required',
    });
  }
  const plan = object(source.plan?.tasks ? source.plan : source);
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  if (tasks.length === 0) {
    throw Object.assign(new Error('collaboration plan requires at least one task'), {
      code: COLLABORATION_PLAN_REJECTED,
      reason: 'tasks_required',
    });
  }
  if (tasks.length > 64) {
    throw Object.assign(new Error('collaboration plan exceeds the ingress task limit'), {
      code: COLLABORATION_PLAN_REJECTED,
      reason: 'task_limit',
    });
  }
  return {
    idempotencyKey: key,
    title: text(source.title || plan.title, 240),
    projectId: text(source.projectId, 200),
    plan,
  };
}

function safeErrorResult(error) {
  const code = text(error?.code, 120) || COLLABORATION_PLAN_REJECTED;
  const reason = text(error?.reason, 120) || 'runtime_rejected';
  const message = code === COLLABORATION_PLAN_REJECTED
    || code.startsWith('COLLABORATION_')
    || code.startsWith('WORKSPACE_')
    || code.startsWith('READ_ONLY_')
    || code.startsWith('PROJECT_')
    ? text(error?.message, 400)
    : 'collaboration plan was rejected by the Runtime';
  return { attempted: true, state: 'rejected', code, reason, message };
}

export async function buildCollaborationLeaderTurnContext({
  session,
  apps = null,
  getTool = getToolDefinitionAsync,
} = {}) {
  const capabilities = getOrganizationRuntimeCapabilities({ publicOnly: true });
  if (!capabilities.durableCollaboration || !isRootLeadershipSession(session)) return '';
  const catalog = await buildAgentCapabilityCatalog({
    apps,
    getTool,
  });
  const profiles = catalogProfiles(catalog).map((profile) => ({
      agentId: profile.agentId,
      name: profile.agentName || profile.agentId,
      role: profile.role,
      roleSource: profile.roleSource || 'explicit',
      selectable: profile.selectable !== false,
      unavailableReasons: Array.isArray(profile.unavailableReasons) ? profile.unavailableReasons : [],
      capabilities: profile.capabilities,
      canDelegate: profile.canDelegate === true,
      maxChildren: profile.maxChildren,
      maxConcurrent: profile.maxConcurrent,
      runtime: {
        default: profile.runtimePolicy?.default || {},
        allowedTools: profile.runtimePolicy?.allowedTools || [],
        allowedProviders: profile.runtimePolicy?.allowedProviders || [],
        allowedProvidersByTool: profile.runtimePolicy?.allowedProvidersByTool || {},
        allowedModels: profile.runtimePolicy?.allowedModels || [],
        allowedModelsByTool: profile.runtimePolicy?.allowedModelsByTool || {},
        allowedEfforts: profile.runtimePolicy?.allowedEfforts || [],
        allowedEffortsByTool: profile.runtimePolicy?.allowedEffortsByTool || {},
      },
    }));
  const runtimeCatalog = await buildOrganizationRuntimeCatalog().catch(() => []);
  return `## Durable Collaboration Plan Ingress

When a user objective genuinely needs persistent dependencies, bounded concurrency, retry, Workspace coordination, or an independent Reviewer, emit exactly one marked JSON plan in addition to your explanation. A simple continuous task should remain in this Session. Clarify the objective and acceptance criteria first, and never emit this block together with an Organization Proposal.

${COLLABORATION_PLAN_START}
{ "schemaVersion": 1, "idempotencyKey": "stable-key", "title": "...", "plan": { "workspacePolicy": "shared-exclusive", "gates": { "independentReview": false }, "tasks": [{ "id": "task-1", "objective": "...", "agentId": "listed-agent-id", "role": "specialist", "runtime": { "tool": "codex", "provider": "provider-profile-id", "model": "model-id", "effort": "medium" }, "dependsOn": [], "acceptance": ["..."], "writablePaths": [] }] } }
${COLLABORATION_PLAN_END}

Use only the listed Agent ids and their declared roles. A task runtime selects tool, provider profile, model and effort. The provider is the non-secret provider profile id and is applied as providerProfile on the child Session. The parent policy is a ceiling; child Agent policy and the live catalog must also allow every requested value. The server validates the plan, capabilities, permissions, Workspace, dependencies, retry policy, runtime selection and idempotency before dispatch. The marked block is a proposal; do not claim that a collaboration, child Session, Run, Reviewer or result exists until the Runtime response confirms it.

roleSource="default" means this is a legacy Agent without an explicit collaborationPolicy. It is visible and may be selected as a bounded specialist, but it cannot delegate or review until an owner assigns an explicit policy.

${buildOrganizationCapabilityPrompt({ capabilities })}

Agent Catalog state: ${catalog.state}
Agent Catalog revision: ${catalog.revision}
Agent Catalog diagnostics:
${JSON.stringify(catalog.errors || [], null, 2)}

Available Agent capability facts:
${JSON.stringify(profiles, null, 2)}

Available Runtime catalog (provider ids are non-secret profile identifiers):
${JSON.stringify(runtimeCatalog, null, 2)}`;
}

export async function processCollaborationPlan({
  session,
  assistantText,
  orchestrator = null,
  turnId = '',
} = {}) {
  if (!COLLABORATION_LEADER_ENABLED) return { attempted: false, skipped: COLLABORATION_LEADER_DISABLED };
  if (!isRootLeadershipSession(session)) return { attempted: false, skipped: 'not_root_leadership' };
  let payload;
  try {
    payload = extractCollaborationPlan(assistantText);
  } catch (error) {
    return safeErrorResult(error);
  }
  if (!payload) return { attempted: false, skipped: COLLABORATION_PLAN_NOT_FOUND };
  let envelope;
  try {
    envelope = normalizePlanEnvelope(payload);
  } catch (error) {
    return safeErrorResult(error);
  }
  try {
    const runtime = orchestrator || (await import('./collaboration-orchestrator.mjs')).getDefaultCollaborationOrchestrator();
    const planKey = turnId
      ? `leader:${session.id}:turn:${text(turnId)}:${envelope.idempotencyKey}`
      : `leader:${session.id}:${envelope.idempotencyKey}`;
    // Legacy marked JSON enters the same validate → persisted validation →
    // dispatch path as native structured tools. This eliminates the old split
    // where a plan could be interpreted once for presentation and differently
    // for the actual fan-out.
    const validation = await validateCollaborationPlanTool({
      rootSessionId: session.id,
      title: envelope.title,
      plan: envelope.plan,
      projectId: envelope.projectId || text(session.projectId),
    }, { orchestrator: runtime });
    const dispatched = await dispatchValidatedCollaborationPlan({
      validationId: validation.validationId,
      idempotencyKey: planKey,
    }, { orchestrator: runtime });
    const collaboration = dispatched?.collaboration;
    if (!collaboration?.id) {
      return safeErrorResult(Object.assign(new Error('collaboration runtime returned no durable record'), {
        code: 'COLLABORATION_RUNTIME_NO_RECORD',
      }));
    }
    return {
      attempted: true,
      state: text(collaboration.state) || 'accepted',
      collaborationId: collaboration.id,
      taskCount: Array.isArray(collaboration.tasks) ? collaboration.tasks.length : 0,
      idempotencyKey: planKey,
      validationId: validation.validationId,
      payloadDigest: validation.payloadDigest,
      replay: Array.isArray(collaboration.events)
        && collaboration.events.some((event) => event?.type === 'plan_frozen'),
    };
  } catch (error) {
    return safeErrorResult(error);
  }
}

export { isRootLeadershipSession, normalizePlanEnvelope };
