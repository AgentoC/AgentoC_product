import { createHash } from 'node:crypto';

const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled', 'expired']);
// Keep the projection bounded for pathological histories while preserving the
// existing continuity behavior for the normal multi-thousand-event range.
const MAX_ITEMS = 10_000;

function text(value, maxChars = 1200) {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function iso(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function sourceRefs(event, extra = {}) {
  const refs = [];
  const ref = {};
  if (positiveInt(event?.seq)) ref.seq = event.seq;
  if (text(event?.runId, 160)) ref.runId = text(event.runId, 160);
  if (text(event?.id, 160)) ref.eventId = text(event.id, 160);
  if (text(extra.toolExecutionId, 160)) ref.toolExecutionId = text(extra.toolExecutionId, 160);
  if (Object.keys(ref).length > 0) refs.push(ref);
  return refs;
}

function digest(value) {
  const input = typeof value === 'string' ? value : JSON.stringify(value || '');
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

function normalizeWorkspace(workspace) {
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) return null;
  const root = text(workspace.root || workspace.folder || workspace.path, 1000);
  if (!root) return null;
  const snapshotRevision = text(workspace.snapshotRevision || workspace.revision, 200)
    || (Number.isInteger(workspace.snapshotRevision || workspace.revision)
      ? String(workspace.snapshotRevision || workspace.revision)
      : '');
  return {
    root,
    ...(snapshotRevision ? { snapshotRevision } : {}),
    ...(iso(workspace.observedAt) ? { observedAt: iso(workspace.observedAt) } : {}),
    ...(typeof workspace.stale === 'boolean' ? { stale: workspace.stale } : {}),
    ...(text(workspace.staleReason, 500) ? { staleReason: text(workspace.staleReason, 500) } : {}),
  };
}

function normalizeGit(git) {
  if (!git || typeof git !== 'object' || Array.isArray(git)) return null;
  const root = text(git.root || git.repositoryRoot, 1000);
  const head = text(git.head || git.headSha || git.headCommit, 200);
  const branch = text(git.branch, 240);
  const worktreeDigest = text(
    git.worktreeDigest
      || git.trackedDiffHash
      || git.untrackedManifestHash,
    240,
  );
  const trackedDiffHash = text(git.trackedDiffHash, 240);
  const untrackedManifestHash = text(git.untrackedManifestHash, 240);
  if (!root && !head && !branch && !worktreeDigest && !trackedDiffHash && !untrackedManifestHash) return null;
  return {
    ...(root ? { root } : {}),
    ...(head ? { head } : {}),
    ...(branch ? { branch } : {}),
    ...(worktreeDigest ? { worktreeDigest } : {}),
    ...(trackedDiffHash ? { trackedDiffHash } : {}),
    ...(untrackedManifestHash ? { untrackedManifestHash } : {}),
    ...(text(git.state, 80) ? { state: text(git.state, 80) } : {}),
    ...(typeof git.dirty === 'boolean' ? { dirty: git.dirty } : {}),
    ...(typeof git.partial === 'boolean' ? { partial: git.partial } : {}),
    ...(text(git.reason, 500) ? { reason: text(git.reason, 500) } : {}),
    ...(iso(git.observedAt) ? { observedAt: iso(git.observedAt) } : {}),
    ...(typeof git.stale === 'boolean' ? { stale: git.stale } : {}),
  };
}

function normalizeFile(event) {
  const path = text(event?.filePath || event?.path, 2000);
  if (!path) return null;
  const contentHash = text(event?.contentHash || event?.contentSha256 || event?.hash, 240);
  const baselineHash = text(event?.baselineHash, 240);
  const changedRanges = Array.isArray(event?.changedRanges)
    ? event.changedRanges.slice(0, 40).map((range) => ({
      ...(positiveInt(range?.startLine) ? { startLine: range.startLine } : {}),
      ...(positiveInt(range?.endLine) ? { endLine: range.endLine } : {}),
    })).filter((range) => Object.keys(range).length > 0)
    : [];
  return {
    id: path,
    path,
    changeType: text(event?.changeType || event?.change, 80) || 'update',
    // A later provider file event without a hash must clear an older hash;
    // retaining it would make an unobserved value look current.
    contentHash: contentHash || null,
    baselineHash: baselineHash || null,
    ...(changedRanges.length > 0 ? { changedRanges } : {}),
    ...(iso(event?.timestamp) ? { observedAt: iso(event.timestamp) } : {}),
    sourceRefs: sourceRefs(event),
  };
}

function eventOutputText(event) {
  if (typeof event?.output === 'string') return event.output;
  if (typeof event?.content === 'string') return event.content;
  if (event?.output && typeof event.output === 'object') {
    try { return JSON.stringify(event.output); } catch { return ''; }
  }
  return '';
}

function normalizeValidation(event) {
  const toolName = text(event?.toolName || event?.name, 300);
  const output = eventOutputText(event);
  if (!toolName && !output) return null;
  const looksLikeValidation = /\b(test|check|lint|validate|build|compile|verify|typecheck)\b/i.test(`${toolName} ${output}`);
  if (!looksLikeValidation && event?.validation !== true) return null;
  const exitCode = Number.isInteger(event?.exitCode) ? event.exitCode : null;
  const state = exitCode === 0
    ? 'passed'
    : (exitCode !== null || /\b(fail|error|failed)\b/i.test(output) ? 'failed' : 'unknown');
  return {
    id: text(event?.validationId || event?.id, 160) || `${toolName || 'validation'}:${event?.seq || 'unknown'}`,
    commandRef: text(event?.commandRef || event?.command || toolName, 500),
    name: toolName || 'validation',
    state,
    ...(exitCode !== null ? { exitCode } : {}),
    ...(iso(event?.timestamp) ? { observedAt: iso(event.timestamp) } : {}),
    ...(text(event?.failureSummary, 1000) ? { failureSummary: text(event.failureSummary, 1000) } : {}),
    evidenceRefs: sourceRefs(event),
  };
}

function normalizeTool(event) {
  const runtime = text(event?.runtime || event?.runtimeFamily, 160);
  const provider = text(event?.provider, 160);
  const model = text(event?.model, 240);
  if (!runtime && !provider && !model) return null;
  const capabilities = event?.providerCapabilities;
  return {
    id: `${runtime || provider || 'runtime'}:${model}`,
    ...(runtime ? { runtime } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(text(event?.capabilitiesDigest, 240)
      ? { capabilitiesDigest: text(event.capabilitiesDigest, 240) }
      : (capabilities ? { capabilitiesDigest: digest(capabilities) } : {})),
    sourceRefs: sourceRefs(event),
  };
}

function normalizeProcess(event) {
  const process = event?.process && typeof event.process === 'object' ? event.process : event;
  const pid = positiveInt(process?.pid || process?.runnerProcessId || process?.toolProcessId);
  const unit = text(process?.unit || process?.unitName || process?.runnerUnitName, 300);
  const kind = text(process?.kind || process?.processKind, 120);
  const state = text(process?.state || process?.processState, 80);
  if (!pid && !unit && !kind) return null;
  return {
    id: text(process?.id, 160) || `${unit || kind || 'process'}:${pid || 'unknown'}`,
    ...(kind ? { kind } : {}),
    ...(state ? { state } : {}),
    ...(pid ? { pid } : {}),
    ...(unit ? { unit } : {}),
    ...(text(process?.runId, 160) ? { runId: text(process.runId, 160) } : {}),
    ...(iso(process?.observedAt || event?.timestamp) ? { observedAt: iso(process?.observedAt || event.timestamp) } : {}),
    sourceRefs: sourceRefs(event),
  };
}

function normalizeArtifact(value, event) {
  const assetId = text(value?.assetId || value?.id, 200);
  if (!assetId) return null;
  return {
    assetId,
    ...(text(value?.name || value?.originalName, 500) ? { name: text(value.name || value.originalName, 500) } : {}),
    ...(text(value?.mimeType, 200) ? { mimeType: text(value.mimeType, 200) } : {}),
    sourceRefs: sourceRefs(event),
  };
}

function normalizeApproval(event, stateOverride = '') {
  const id = text(event?.approvalId || event?.providerApprovalId || event?.providerRequestId, 200);
  if (!id) return null;
  const status = text(stateOverride || event?.status || event?.decision, 80).toLowerCase()
    || (event?.type === 'approval_request' ? 'pending' : 'unknown');
  return {
    id,
    kind: text(event?.kind || event?.providerMethod, 160),
    state: status === 'approved' ? 'approved' : status === 'denied' ? 'denied' : status,
    ...(iso(event?.expiresAt) ? { expiresAt: iso(event.expiresAt) } : {}),
    ...(text(event?.scopeDigest, 240) ? { scopeDigest: text(event.scopeDigest, 240) } : {}),
    sourceRefs: sourceRefs(event),
  };
}

function normalizePrivilegedBatchApproval(event, category, operation) {
  const approvalId = text(operation?.approvalId || operation?.opId, 200);
  if (!approvalId) return null;
  const status = text(event?.status, 80).toLowerCase() || 'pending';
  return {
    id: approvalId,
    kind: `privileged:${category}`,
    state: status === 'approved' ? 'approved' : status === 'denied' ? 'denied' : status,
    ...(text(operation?.manifestHash, 240) ? { scopeDigest: text(operation.manifestHash, 240) } : {}),
    sourceRefs: sourceRefs(event),
  };
}

function privilegedDecisionEntries(decisions) {
  if (!decisions || typeof decisions !== 'object') return [];
  if (Array.isArray(decisions)) {
    return decisions.map((entry) => [
      text(entry?.approvalId || entry?.opId || entry?.id, 200),
      entry?.decision ?? entry?.status ?? entry?.approved,
    ]).filter(([id]) => id);
  }
  return Object.entries(decisions)
    .map(([id, decision]) => [text(id, 200), decision])
    .filter(([id]) => id);
}

function normalizePrivilegedDecision(value) {
  if (value === true || value === 'true') return 'approved';
  if (value === false || value === 'false') return 'denied';
  const normalized = text(value, 80).toLowerCase();
  if (['approve', 'approved', 'accept', 'accepted', 'allow', 'allowed'].includes(normalized)) return 'approved';
  if (['deny', 'denied', 'decline', 'declined', 'reject', 'rejected', 'cancel', 'cancelled', 'canceled'].includes(normalized)) return 'denied';
  return normalized || 'unknown';
}

function upsert(items, item) {
  const index = items.findIndex((entry) => (
    (item.id && entry.id === item.id)
    || (item.assetId && entry.assetId === item.assetId)
  ));
  if (index < 0) return [...items, item].slice(-MAX_ITEMS);
  const next = items.slice();
  next[index] = { ...next[index], ...item, sourceRefs: [...(next[index].sourceRefs || []), ...(item.sourceRefs || [])].slice(-16) };
  return next;
}

function normalizeRun(run) {
  if (!run || typeof run !== 'object') return {};
  const state = text(run.state || run.status, 80).toLowerCase();
  return {
    ...(text(run.id, 160) ? { id: text(run.id, 160) } : {}),
    ...(state ? { state } : {}),
    ...(text(run.runnerProcessId || run.pid, 160) ? { pid: text(run.runnerProcessId || run.pid, 160) } : {}),
    ...(text(run.runnerUnitName || run.unitName, 300) ? { unit: text(run.runnerUnitName || run.unitName, 300) } : {}),
    ...(iso(run.updatedAt || run.completedAt || run.startedAt) ? { observedAt: iso(run.updatedAt || run.completedAt || run.startedAt) } : {}),
  };
}

export function createInitialExecutionState() {
  return {
    activeRunId: null,
    lastRunId: null,
    workspace: null,
    git: null,
    files: [],
    validations: [],
    processes: [],
    tools: [],
    approvals: [],
    artifacts: [],
  };
}

export function buildExecutionStateProjection({
  run = null,
  events = [],
  workspace = null,
  git = null,
  processes = [],
  artifacts = [],
} = {}) {
  const reducer = createExecutionStateProjectionReducer({ run, workspace, git });
  for (const event of Array.isArray(events) ? events : []) reducer.push(event);
  return reducer.finish({ run, processes, artifacts });
}

// Streaming counterpart to buildExecutionStateProjection.  Continuity
// rebuilds can contain hundreds of thousands of events; keeping the
// projection's mutable state and privileged approval map here avoids retaining
// the whole event array merely to derive the same bounded execution snapshot.
export function createExecutionStateProjectionReducer({
  run = null,
  workspace = null,
  git = null,
} = {}) {
  let state = createInitialExecutionState();
  state.workspace = normalizeWorkspace(workspace);
  state.git = normalizeGit(git);
  const normalizedRun = normalizeRun(run);
  if (normalizedRun.id) {
    state.lastRunId = normalizedRun.id;
    if (!TERMINAL_RUN_STATES.has(normalizedRun.state)) state.activeRunId = normalizedRun.id;
    const process = normalizeProcess({
      ...run,
      id: normalizedRun.id,
      runId: normalizedRun.id,
      processState: normalizedRun.state,
      processKind: 'runner',
    });
    if (process) state.processes = upsert(state.processes, process);
  }

  const privilegedApprovalIds = new Map();
  function push(event) {
    if (!event || typeof event !== 'object') return;
    const eventRunId = text(event.runId, 160);
    if (eventRunId) state.lastRunId = eventRunId;
    if (event.type === 'file_change') {
      const file = normalizeFile(event);
      if (file) state.files = upsert(state.files, file);
    }
    if (event.type === 'tool_result') {
      const validation = normalizeValidation(event);
      if (validation) state.validations = upsert(state.validations, validation);
    }
    if (event.type === 'approval_request') {
      const approval = normalizeApproval(event);
      if (approval) state.approvals = upsert(state.approvals, approval);
    }
    if (event.type === 'approval_response') {
      const approval = normalizeApproval(event, text(event.decision || event.status, 80));
      if (approval) state.approvals = upsert(state.approvals, approval);
    }
    if (event.type === 'privileged_batch_request') {
      for (const category of ['other', 'delete', 'installAuto']) {
        const operations = Array.isArray(event[category]) ? event[category] : [];
        for (const operation of operations) {
          const approval = normalizePrivilegedBatchApproval(event, category, operation);
          if (!approval) continue;
          state.approvals = upsert(state.approvals, approval);
          privilegedApprovalIds.set(`${text(event.batchId, 200)}\u0000${category}\u0000${approval.id}`, approval.id);
        }
      }
    }
    if (event.type === 'privileged_batch_response') {
      const batchId = text(event.batchId, 200);
      const category = text(event.category, 120);
      for (const [id, decision] of privilegedDecisionEntries(event.decisions)) {
        const approvalId = privilegedApprovalIds.get(`${batchId}\u0000${category}\u0000${id}`) || id;
        state.approvals = upsert(state.approvals, {
          id: approvalId,
          kind: `privileged:${category || 'batch'}`,
          state: normalizePrivilegedDecision(decision),
          sourceRefs: sourceRefs(event),
        });
      }
    }
    if (event.type === 'message') {
      for (const attachment of Array.isArray(event.attachments) ? event.attachments : []) {
        const artifact = normalizeArtifact(attachment, event);
        if (artifact) state.artifacts = upsert(state.artifacts, artifact);
      }
    }
    const tool = normalizeTool(event);
    if (tool) state.tools = upsert(state.tools, tool);
    const process = event.type === 'process' || event.process ? normalizeProcess(event) : null;
    if (process) state.processes = upsert(state.processes, process);
    if (event.type === 'run_started' && eventRunId) state.activeRunId = eventRunId;
    if (['run_finished', 'run_completed', 'run_failed', 'run_cancelled'].includes(event.type)) {
      state.activeRunId = null;
      if (eventRunId) state.lastRunId = eventRunId;
    }
  }

  function finish({ run: finalRun = run, processes = [], artifacts = [] } = {}) {
    for (const process of Array.isArray(processes) ? processes : []) {
      const normalized = normalizeProcess(process);
      if (normalized) state.processes = upsert(state.processes, normalized);
    }
    for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
      const normalized = normalizeArtifact(artifact, { seq: positiveInt(artifact?.seq) });
      if (normalized) state.artifacts = upsert(state.artifacts, normalized);
    }
    // A supplied Run record is the authoritative live snapshot. History can lag
    // it while the sidecar is still being reconciled, so do not let an older
    // terminal event resurrect or clear the current run state.
    const finalNormalizedRun = normalizeRun(finalRun);
    if (finalNormalizedRun.id) {
      state.lastRunId = finalNormalizedRun.id;
      state.activeRunId = TERMINAL_RUN_STATES.has(finalNormalizedRun.state)
        ? null
        : finalNormalizedRun.id;
    }
    return state;
  }

  return { push, finish };
}

export function mergeExecutionState(base, overlay) {
  const left = { ...createInitialExecutionState(), ...(base || {}) };
  const right = overlay && typeof overlay === 'object' ? overlay : {};
  const merged = {
    ...left,
    ...right,
  };
  for (const key of ['files', 'validations', 'processes', 'tools', 'approvals', 'artifacts']) {
    merged[key] = [];
    for (const item of [...(left[key] || []), ...(right[key] || [])]) {
      if (item && typeof item === 'object') merged[key] = upsert(merged[key], item);
    }
  }
  return merged;
}

export function normalizeExecutionState(value) {
  return mergeExecutionState(createInitialExecutionState(), value);
}
