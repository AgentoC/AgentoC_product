import { getApp } from './apps.mjs';
import { mutateSessionMeta } from './session-meta-store.mjs';
import { getToolDefinitionAsync } from '../lib/tools.mjs';

const CLAUDE_COMPATIBILITY_TOOL_ID = 'claude';
const CLAUDE_BIDI_TOOL_ID = 'claude-bidi';
const CLAUDE_COMPATIBILITY_RUNTIME_FAMILY = 'claude-stream-json';
const RISK_GATED_MODES = new Set(['safe', 'recommended']);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}
async function resolveToolDefinition(toolId) {
  const normalizedToolId = trimString(toolId);
  if (!normalizedToolId) return null;
  try {
    return await getToolDefinitionAsync(normalizedToolId);
  } catch {
    return null;
  }
}

async function resolveAgentTool(agentId) {
  const normalizedAgentId = trimString(agentId);
  if (!normalizedAgentId) return null;
  const app = await getApp(normalizedAgentId).catch(() => null);
  const toolId = trimString(app?.tool);
  if (!toolId || toolId === normalizedAgentId) return null;
  const definition = await resolveToolDefinition(toolId);
  if (!definition) return null;
  return {
    tool: trimString(definition.id) || toolId,
    definition,
    agentId: trimString(app?.id) || normalizedAgentId,
  };
}

function shouldUseRiskGatedRuntime({ riskMode = '', privilegedMode = false } = {}) {
  return RISK_GATED_MODES.has(trimString(riskMode)) || privilegedMode === true;
}

function isClaudeCompatibilityFallback(definition) {
  return definition?.internalFallback === true
    && trimString(definition.id) === CLAUDE_COMPATIBILITY_TOOL_ID
    && trimString(definition.runtimeFamily) === CLAUDE_COMPATIBILITY_RUNTIME_FAMILY;
}

async function preferClaudeBidiForRiskGate(binding, options) {
  if (!shouldUseRiskGatedRuntime(options) || !isClaudeCompatibilityFallback(binding?.definition)) {
    return binding;
  }
  const bidiDefinition = await resolveToolDefinition(CLAUDE_BIDI_TOOL_ID);
  if (!bidiDefinition) return binding;
  return {
    ...binding,
    tool: trimString(bidiDefinition.id) || CLAUDE_BIDI_TOOL_ID,
    definition: bidiDefinition,
    source: `${binding.source || 'runtime-tool'}-risk-gated`,
  };
}

/**
 * Resolve the executable Runtime tool for a Session or one-run override.
 *
 * Session metadata stores the Agent separately as templateId, but historical
 * paths also wrote that Agent id into `tool`. Keep the repair at this boundary
 * so callers never need to know whether the stored value is a Runtime id or an
 * Agent id.
 */
export async function resolveSessionRuntimeTool(session, {
  requestedTool = '',
  fallbackToTemplate = true,
  riskMode = '',
  privilegedMode = false,
} = {}) {
  const resolutionOptions = { riskMode, privilegedMode };
  const explicitTool = trimString(requestedTool);
  const storedTool = trimString(session?.tool);
  const candidate = explicitTool || storedTool;
  const directDefinition = await resolveToolDefinition(candidate);
  if (directDefinition) {
    return preferClaudeBidiForRiskGate({
      tool: trimString(directDefinition.id) || candidate,
      definition: directDefinition,
      source: 'runtime-tool',
      agentId: '',
    }, resolutionOptions);
  }

  const directAgent = await resolveAgentTool(candidate);
  if (directAgent) {
    return preferClaudeBidiForRiskGate({
      ...directAgent,
      source: 'agent-tool',
    }, resolutionOptions);
  }

  if (fallbackToTemplate && !explicitTool) {
    const templateId = trimString(session?.templateId || session?.agentId);
    const templateAgent = await resolveAgentTool(templateId);
    if (templateAgent) {
      return preferClaudeBidiForRiskGate({
        ...templateAgent,
        source: 'template-tool',
      }, resolutionOptions);
    }
  }

  return {
    tool: candidate,
    definition: null,
    source: 'unresolved',
    agentId: '',
  };
}

/**
 * Persist the Runtime id when a historical Session carried an Agent id in its
 * `tool` field. The compare-and-set guard avoids overwriting a concurrent tool
 * selection made after the read projection began.
 */
export async function repairSessionRuntimeTool(sessionId, session, options = {}) {
  const binding = await resolveSessionRuntimeTool(session, options);
  const currentTool = trimString(session?.tool);
  if (!binding.definition || !binding.tool || binding.tool === currentTool) {
    return {
      ...binding,
      session,
      changed: false,
    };
  }

  const result = await mutateSessionMeta(sessionId, (draft) => {
    if (trimString(draft.tool) !== currentTool) return false;
    draft.tool = binding.tool;
    draft.updatedAt = new Date().toISOString();
    return true;
  });
  return {
    ...binding,
    session: result.meta || session,
    changed: result.changed === true,
  };
}
