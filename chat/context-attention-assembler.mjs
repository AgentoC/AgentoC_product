import { createHash } from 'node:crypto';
import { formatToolResultDescriptor } from './tool-result-descriptor.mjs';

export const CONTEXT_PLAN_SCHEMA_VERSION = 1;
export const CONTEXT_ATTENTION_VERSION = 'attention-v1';
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 120_000;
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 8_000;
export const DEFAULT_CONTEXT_SAFETY_MARGIN = 0.05;

const MAX_RECALL_ITEMS = 8;
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'have', 'will',
  '继续', '然后', '这个', '那个', '请', '把', '的', '了', '和', '与',
]);

function text(value, maxChars = 24_000) {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function digest(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value || '');
  return `sha256:${createHash('sha256').update(serialized, 'utf8').digest('hex')}`;
}

function stableJson(value) {
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function estimateTokens(value, options = {}) {
  const chars = typeof value === 'string' ? value.length : stableJson(value).length;
  const charsPerToken = Number.isFinite(options.charsPerToken) && options.charsPerToken >= 1
    ? options.charsPerToken
    : 3;
  return Math.max(1, Math.ceil(chars / charsPerToken));
}

function sourceRefs(value) {
  const refs = Array.isArray(value) ? value : [];
  return refs
    .filter((ref) => ref && typeof ref === 'object')
    .slice(0, 32)
    .map((ref) => ({
      ...(Number.isInteger(ref.seq) && ref.seq > 0 ? { seq: ref.seq } : {}),
      ...(text(ref.runId, 180) ? { runId: text(ref.runId, 180) } : {}),
      ...(text(ref.eventId, 180) ? { eventId: text(ref.eventId, 180) } : {}),
      ...(text(ref.toolExecutionId, 180) ? { toolExecutionId: text(ref.toolExecutionId, 180) } : {}),
    }))
    .filter((ref) => Object.keys(ref).length > 0);
}

function clip(value, maxChars = 12_000) {
  const normalized = text(value, Number.MAX_SAFE_INTEGER);
  if (normalized.length <= maxChars) return normalized;
  const head = Math.max(1, Math.floor(maxChars * 0.65));
  const tail = Math.max(1, maxChars - head - 40);
  return `${normalized.slice(0, head).trimEnd()}\n[... context item clipped ...]\n${normalized.slice(-tail).trimStart()}`;
}

function item({ id, type, priority, content, sourceRefs: refs = [], representation = 'structured', bucket = '' }) {
  const normalizedContent = clip(content);
  return {
    id: text(id, 240) || `${type}:${digest(normalizedContent).slice(-16)}`,
    type: text(type, 100) || 'context',
    priority,
    bucket: text(bucket, 80) || `p${priority}`,
    representation,
    sourceRefs: sourceRefs(refs),
    estimatedTokens: estimateTokens(normalizedContent),
    contentDigest: digest(normalizedContent),
    content: normalizedContent,
  };
}

function taskFor(input) {
  return input?.checkpoint?.task
    || input?.handoff?.task
    || input?.task
    || null;
}

function executionFor(input) {
  return input?.checkpoint?.execution
    || input?.handoff?.execution
    || input?.execution
    || null;
}

function formatStructured(label, value, maxChars = 18_000) {
  const json = stableJson(value);
  return json ? `${label}:\n${clip(json, maxChars)}` : '';
}

function lexicalTokens(value) {
  return [...new Set(
    String(value || '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}_./:-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !STOP_WORDS.has(token))
      .slice(0, 80),
  )];
}

function buildRecallItems({ query, events, toolResults }) {
  const keys = lexicalTokens(query).slice(0, 40);
  if (keys.length === 0) return [];
  const candidates = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue;
    const body = event.bodyPreview || event.content || event.output || event.toolInput || event.filePath || '';
    const candidateText = text(body, 6000);
    if (!candidateText) continue;
    candidates.push({
      id: `recall:event:${event.seq || event.id || candidates.length}`,
      type: 'recall',
      priority: 3,
      bucket: 'recall',
      representation: 'reference',
      sourceRefs: sourceRefs([{
        seq: event.seq,
        runId: event.runId,
        eventId: event.id,
      }]),
      content: `[Historical ${event.type || 'event'} reference]\n${clip(candidateText, 2400)}`,
    });
  }
  for (const descriptor of Array.isArray(toolResults) ? toolResults : []) {
    const candidateText = formatToolResultDescriptor(descriptor, { includePreview: false });
    if (!candidateText) continue;
    candidates.push({
      id: `recall:tool:${descriptor.toolExecutionId}`,
      type: 'recall',
      priority: 3,
      bucket: 'recall',
      representation: 'reference',
      sourceRefs: descriptor.evidenceRefs,
      content: candidateText,
    });
  }
  return candidates
    .map((candidate, index) => {
      const lower = candidate.content.toLowerCase();
      const score = keys.reduce((total, key) => total + (lower.includes(key) ? 1 : 0), 0);
      return { candidate, score, index };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, MAX_RECALL_ITEMS)
    .map(({ candidate }) => item(candidate));
}

function addCandidate(target, candidate) {
  if (!candidate?.content) return;
  const normalized = item(candidate);
  if (target.some((entry) => entry.contentDigest === normalized.contentDigest)) return;
  target.push(normalized);
}

function normalizeMaxInputTokens(value) {
  return positiveInt(value) || DEFAULT_CONTEXT_WINDOW_TOKENS;
}

function chooseBucket(items, budget, selected, omitted, seenDigests) {
  let used = 0;
  for (const candidate of items) {
    const normalized = item(candidate);
    if (seenDigests.has(normalized.contentDigest)) continue;
    if (normalized.estimatedTokens <= budget - used) {
      selected.push(normalized);
      seenDigests.add(normalized.contentDigest);
      used += normalized.estimatedTokens;
    } else {
      omitted.push({ id: normalized.id, reason: 'bucket_budget', priority: normalized.priority });
    }
  }
  return used;
}

export function buildCanonicalHandoff({
  checkpoint = null,
  task = null,
  execution = null,
  toolResults = [],
  recentEvents = [],
  sourceRevision = 0,
  workspaceRevision = '',
} = {}) {
  const resolvedTask = task || checkpoint?.task || null;
  const resolvedExecution = execution || checkpoint?.execution || null;
  return {
    task: resolvedTask,
    execution: resolvedExecution,
    toolResults: Array.isArray(toolResults) ? toolResults.slice(-128) : [],
    recentTranscriptRefs: (Array.isArray(recentEvents) ? recentEvents : [])
      .map((event) => ({
        ...(Number.isInteger(event?.seq) ? { seq: event.seq } : {}),
        ...(text(event?.runId, 180) ? { runId: text(event.runId, 180) } : {}),
        ...(text(event?.id, 180) ? { eventId: text(event.id, 180) } : {}),
        type: text(event?.type, 80),
      }))
      .filter((ref) => ref.type)
      .slice(-256),
    sourceRevision: positiveInt(sourceRevision) || 0,
    workspaceRevision: text(workspaceRevision, 240),
  };
}

export function assembleContextPlan({
  canonicalContext = {},
  checkpoint = null,
  handoff = null,
  task = null,
  execution = null,
  toolResults = [],
  recentEvents = [],
  maxInputTokens = null,
  outputReserveTokens = DEFAULT_OUTPUT_RESERVE_TOKENS,
  safetyMargin = DEFAULT_CONTEXT_SAFETY_MARGIN,
  sourceRevision = 0,
  workspaceRevision = '',
} = {}) {
  const canonicalHandoff = handoff || buildCanonicalHandoff({
    checkpoint,
    task,
    execution,
    toolResults,
    recentEvents,
    sourceRevision,
    workspaceRevision,
  });
  const maxTokens = normalizeMaxInputTokens(maxInputTokens || canonicalContext?.contextBudget?.maxInputTokens);
  const reserve = Math.max(0, positiveInt(outputReserveTokens) || DEFAULT_OUTPUT_RESERVE_TOKENS);
  const margin = Math.max(0, Math.min(0.25, Number.isFinite(safetyMargin) ? safetyMargin : DEFAULT_CONTEXT_SAFETY_MARGIN));
  const availableTokens = Math.max(1, Math.floor((maxTokens - reserve) * (1 - margin)));
  const selected = [];
  const omitted = [];
  const seenDigests = new Set();
  const sections = canonicalContext?.sections || {};

  const mandatory = [];
  addCandidate(mandatory, {
    id: 'current-user-request',
    type: 'current_request',
    priority: 0,
    bucket: 'mandatory',
    representation: 'raw',
    content: text(canonicalContext?.userText, 16_000),
  }, new Set());
  const resolvedTask = taskFor({ checkpoint, handoff: canonicalHandoff, task });
  const resolvedExecution = executionFor({ checkpoint, handoff: canonicalHandoff, execution });
  if (resolvedTask?.goal) {
    addCandidate(mandatory, {
      id: 'task-goal',
      type: 'task_goal',
      priority: 0,
      bucket: 'mandatory',
      content: formatStructured('Task goal', resolvedTask.goal),
      sourceRefs: resolvedTask.goal.sourceRefs,
    }, new Set());
  }
  if (resolvedExecution?.workspace?.stale === true) {
    addCandidate(mandatory, {
      id: 'workspace-stale-warning',
      type: 'workspace_warning',
      priority: 0,
      bucket: 'mandatory',
      content: formatStructured('Workspace stale warning', resolvedExecution.workspace),
    }, new Set());
  }
  const pendingApprovals = Array.isArray(resolvedExecution?.approvals)
    ? resolvedExecution.approvals.filter((approval) => ['pending', 'requested'].includes(approval?.state))
    : [];
  if (pendingApprovals.length > 0) {
    addCandidate(mandatory, {
      id: 'pending-approvals',
      type: 'pending_approval',
      priority: 0,
      bucket: 'mandatory',
      content: formatStructured('Pending approvals', pendingApprovals),
    }, new Set());
  }
  const mandatoryTokens = mandatory.reduce((total, entry) => total + entry.estimatedTokens, 0);
  if (mandatoryTokens > availableTokens) {
    const error = new Error('mandatory context items exceed the available context budget');
    error.code = 'CONTEXT_MANDATORY_OVER_BUDGET';
    error.requiredTokens = mandatoryTokens;
    error.availableTokens = availableTokens;
    throw error;
  }
  for (const entry of mandatory) {
    if (!seenDigests.has(entry.contentDigest)) {
      selected.push(entry);
      seenDigests.add(entry.contentDigest);
    }
  }

  const structured = [];
  if (resolvedTask) {
    addCandidate(structured, {
      id: 'task-working-state',
      type: 'task_state',
      priority: 1,
      bucket: 'structured',
      content: formatStructured('Task state', {
        status: resolvedTask.status,
        nextAction: resolvedTask.nextAction,
      }),
      sourceRefs: resolvedTask.nextAction?.sourceRefs,
    }, seenDigests);
    for (const [key, label] of [
      ['plan', 'Active plan'],
      ['decisions', 'Decisions'],
      ['completedWork', 'Completed work'],
      ['failedAttempts', 'Failed attempts'],
      ['blockers', 'Blockers'],
      ['unresolved', 'Unresolved items'],
    ]) {
      if (!Array.isArray(resolvedTask[key]) && !resolvedTask[key]) continue;
      addCandidate(structured, {
        id: `task:${key}`,
        type: `task_${key}`,
        priority: 1,
        bucket: 'structured',
        content: formatStructured(label, resolvedTask[key]),
        sourceRefs: Array.isArray(resolvedTask[key])
          ? resolvedTask[key].flatMap((entry) => entry?.sourceRefs || entry?.evidenceRefs || []).slice(0, 32)
          : resolvedTask[key]?.sourceRefs,
      }, seenDigests);
    }
  }
  if (resolvedExecution) {
    addCandidate(structured, {
      id: 'execution-state',
      type: 'execution_state',
      priority: 1,
      bucket: 'structured',
      content: formatStructured('Execution workspace', {
        workspace: resolvedExecution.workspace,
        git: resolvedExecution.git,
        activeRunId: resolvedExecution.activeRunId,
        lastRunId: resolvedExecution.lastRunId,
      }),
    }, seenDigests);
    for (const [key, label] of [
      ['files', 'Changed files'],
      ['validations', 'Validations and tests'],
      ['processes', 'Processes'],
      ['tools', 'Runtime tools'],
      ['approvals', 'Approvals'],
      ['artifacts', 'Artifacts'],
    ]) {
      if (!Array.isArray(resolvedExecution[key]) || resolvedExecution[key].length === 0) continue;
      addCandidate(structured, {
        id: `execution:${key}`,
        type: `execution_${key}`,
        priority: 1,
        bucket: 'structured',
        content: formatStructured(label, resolvedExecution[key]),
        sourceRefs: resolvedExecution[key].flatMap((entry) => entry?.sourceRefs || entry?.evidenceRefs || []).slice(0, 32),
      }, seenDigests);
    }
  }
  for (const key of ['managerTurnContext', 'planArtifact', 'goalInstructions', 'projectMemoryContext']) {
    if (text(sections[key])) {
      addCandidate(structured, {
        id: `section:${key}`,
        type: key,
        priority: 1,
        bucket: 'structured',
        representation: 'structured',
        content: sections[key],
      }, seenDigests);
    }
  }

  const recent = [];
  if (text(sections.continuationContext)) {
    addCandidate(recent, {
      id: 'recent-continuation',
      type: 'recent_transcript',
      priority: 2,
      bucket: 'recent',
      representation: 'raw',
      content: sections.continuationContext,
      sourceRefs: canonicalHandoff.recentTranscriptRefs,
    }, seenDigests);
  }
  const descriptors = (Array.isArray(toolResults) ? toolResults : canonicalHandoff.toolResults) || [];
  const tools = descriptors.map((descriptor) => ({
    id: `tool:${descriptor.toolExecutionId}`,
    type: 'tool_result',
    priority: 2,
    bucket: 'tools',
    representation: 'reference',
    content: formatToolResultDescriptor(descriptor),
    sourceRefs: descriptor.evidenceRefs,
  }));
  const recall = buildRecallItems({
    query: `${canonicalContext?.userText || ''} ${resolvedTask?.goal?.text || ''} ${resolvedTask?.nextAction?.text || ''}`,
    events: recentEvents,
    toolResults: descriptors,
  });

  const p1Budget = Math.floor(availableTokens * 0.30);
  const recentBudget = Math.floor(availableTokens * 0.40);
  const toolBudget = Math.floor(availableTokens * 0.12);
  const recallBudget = Math.floor(availableTokens * 0.10);
  let usedTokens = mandatoryTokens;
  usedTokens += chooseBucket(structured, p1Budget, selected, omitted, seenDigests);
  usedTokens += chooseBucket(recent, recentBudget, selected, omitted, seenDigests);
  usedTokens += chooseBucket(tools, toolBudget, selected, omitted, seenDigests);
  usedTokens += chooseBucket(recall, recallBudget, selected, omitted, seenDigests);

  const remaining = Math.max(0, availableTokens - usedTokens);
  if (remaining > 0) {
    usedTokens += chooseBucket(
      [...structured, ...recent, ...tools, ...recall],
      remaining,
      selected,
      omitted,
      seenDigests,
    );
  }

  const includedSourceRefs = selected.flatMap((entry) => entry.sourceRefs || []).slice(0, 128);
  const planPayload = {
    schemaVersion: CONTEXT_PLAN_SCHEMA_VERSION,
    attentionVersion: CONTEXT_ATTENTION_VERSION,
    sessionRevision: canonicalHandoff.sourceRevision || 0,
    workspaceRevision: canonicalHandoff.workspaceRevision || '',
    target: {
      runtimeFamily: text(canonicalContext?.runtimeFamily, 160) || 'unknown',
      provider: text(canonicalContext?.provider, 160),
    },
    budget: {
      maxInputTokens: maxTokens,
      outputReserveTokens: reserve,
      availableTokens,
      estimatedTokens: usedTokens,
      safetyMargin: margin,
      estimator: 'ceil(chars/3)',
    },
    items: selected.map(({ content, ...metadata }) => metadata),
    omitted,
    receipt: {
      rendererVersion: CONTEXT_ATTENTION_VERSION,
      includedSourceRefs,
      contentDigest: digest(selected.map((entry) => entry.contentDigest).join('|')),
    },
  };
  return {
    ...planPayload,
    selectedItems: selected,
    canonicalHandoff,
    diagnostics: {
      mandatoryTokens,
      selectedItemCount: selected.length,
      omittedItemCount: omitted.length,
      duplicationAvoided: Math.max(0, structured.length + recent.length + tools.length + recall.length - selected.length),
    },
  };
}

export function applyContextPlanToCanonicalContext(canonicalContext, plan) {
  if (!canonicalContext || !plan || !Array.isArray(plan.selectedItems)) return canonicalContext;
  const carrierOwnedTypes = new Map([
    ['managerTurnContext', 'managerTurnContext'],
    ['planArtifact', 'planArtifact'],
    ['goalInstructions', 'goalInstructions'],
    ['projectMemoryContext', 'projectMemoryContext'],
  ]);
  const selectedByCarrier = new Map();
  const selectedContinuation = [];
  for (const entry of plan.selectedItems) {
    if (entry.type === 'current_request' || !entry.content) continue;
    const carrierKey = carrierOwnedTypes.get(entry.type);
    if (carrierKey) {
      selectedByCarrier.set(carrierKey, entry.content);
      continue;
    }
    selectedContinuation.push(`[${entry.type || 'context'}]\n${entry.content}`);
  }
  const originalSections = canonicalContext.sections || {};
  const nextSections = {
    ...originalSections,
    // A budget omission must not reintroduce the original unbudgeted memory.
    projectMemoryContext: selectedByCarrier.get('projectMemoryContext') || '',
    ...(selectedByCarrier.has('managerTurnContext')
      ? { managerTurnContext: selectedByCarrier.get('managerTurnContext') }
      : {}),
    ...(selectedByCarrier.has('planArtifact')
      ? { planArtifact: selectedByCarrier.get('planArtifact') }
      : {}),
    ...(selectedByCarrier.has('goalInstructions')
      ? { goalInstructions: selectedByCarrier.get('goalInstructions') }
      : {}),
  };
  if (selectedContinuation.length > 0) {
    nextSections.continuationContext = selectedContinuation.join('\n\n---\n\n');
  } else {
    nextSections.continuationContext = '';
  }
  return {
    ...canonicalContext,
    sections: nextSections,
  };
}
