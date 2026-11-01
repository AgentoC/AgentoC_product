// Observational bridge from the canonical session approval events to the
// provider-neutral orchestration ledger.
//
// Approval events remain the source of truth for provider execution and the
// privileged gate.  This module only projects their human-wait lifecycle into
// an Execution/Interrupt pair so the common reconciler, status API and future
// harnesses can reason about a wait without inventing a second approval store.
import {
  ensureExecution,
  getExecutionByScope,
  openInterrupt,
  resolveInterrupt,
} from './orchestration-store.mjs';

const MAX_TEXT = 500;
const APPROVAL_SCOPE_KIND = 'approval';
const PRIVILEGED_SCOPE_KIND = 'privileged_approval';

function text(value, max = MAX_TEXT) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function safeIso(value) {
  const candidate = text(value, 80);
  if (!candidate) return '';
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function safeSessionId(value) {
  return text(value, 240);
}

function safeApprovalId(event) {
  return text(event?.approvalId || event?.providerApprovalId || event?.providerRequestId);
}

function safeBatchId(event) {
  return text(event?.batchId);
}

function scopeId(sessionId, id) {
  return `${sessionId}:${id}`;
}

function approvalSpec(sessionId, event, approvalId) {
  return {
    sessionId,
    approvalId,
    runId: text(event?.runId, 240),
    turnId: text(event?.turnId, 240),
    providerMethod: text(event?.providerMethod, 240),
    source: text(event?.source, 120),
    kind: text(event?.kind, 120),
    operation: text(event?.operation, 240),
    title: text(event?.title),
    reason: text(event?.reason),
    risk: text(event?.risk, 80),
  };
}

function approvalPayload(sessionId, event, approvalId) {
  return {
    sessionId,
    approvalId,
    runId: text(event?.runId, 240),
    turnId: text(event?.turnId, 240),
    providerMethod: text(event?.providerMethod, 240),
    kind: text(event?.kind, 120),
    operation: text(event?.operation, 240),
    title: text(event?.title),
    reason: text(event?.reason),
    risk: text(event?.risk, 80),
    // Deliberately omit command, cwd, paths, permissions and provider
    // payloads: the ledger is an operational projection, not a credential or
    // privileged-command archive.
  };
}

function privilegedCategories(event) {
  return ['other', 'delete', 'install'].filter((category) => {
    const key = category === 'install' ? 'installAuto' : category;
    return Array.isArray(event?.[key]) && event[key].length > 0;
  });
}

function privilegedPayload(sessionId, event, batchId, category) {
  const key = category === 'install' ? 'installAuto' : category;
  const operations = Array.isArray(event?.[key]) ? event[key] : [];
  return {
    sessionId,
    batchId,
    category,
    runId: text(event?.runId, 240),
    turnId: text(event?.turnId, 240),
    risk: text(event?.risk, 80),
    operationCount: operations.length,
  };
}

async function mirrorApprovalRequest(sessionId, event) {
  const approvalId = safeApprovalId(event);
  if (!approvalId) return null;
  const execution = await ensureExecution({
    scopeKind: APPROVAL_SCOPE_KIND,
    scopeId: scopeId(sessionId, approvalId),
    rootSessionId: sessionId,
    kind: 'approval',
    state: 'running',
    spec: approvalSpec(sessionId, event, approvalId),
  });
  return openInterrupt({
    executionId: execution.id,
    stableKey: `approval:${approvalId}`,
    kind: 'approval',
    payload: approvalPayload(sessionId, event, approvalId),
    deadlineAt: safeIso(event?.deadlineAt || event?.expiresAt),
  });
}

async function mirrorPrivilegedRequest(sessionId, event) {
  const batchId = safeBatchId(event);
  if (!batchId) return null;
  const execution = await ensureExecution({
    scopeKind: PRIVILEGED_SCOPE_KIND,
    scopeId: scopeId(sessionId, batchId),
    rootSessionId: sessionId,
    kind: 'privileged_approval',
    state: 'running',
    spec: {
      sessionId,
      batchId,
      runId: text(event?.runId, 240),
      turnId: text(event?.turnId, 240),
      risk: text(event?.risk, 80),
      categories: privilegedCategories(event),
    },
  });
  const interrupts = [];
  for (const category of privilegedCategories(event)) {
    interrupts.push(await openInterrupt({
      executionId: execution.id,
      stableKey: `batch:${batchId}:${category}`,
      kind: 'privileged_approval',
      payload: privilegedPayload(sessionId, event, batchId, category),
    }));
  }
  return interrupts;
}

async function findExecution(scopeKind, sessionId, id) {
  return getExecutionByScope(scopeKind, scopeId(sessionId, id), { includeDetails: true });
}

async function resolveApprovalResponse(sessionId, event) {
  const approvalId = safeApprovalId(event);
  if (!approvalId) return null;
  const execution = await findExecution(APPROVAL_SCOPE_KIND, sessionId, approvalId);
  if (!execution) return null;
  const interrupt = execution.interrupts?.find((entry) => entry.state === 'open'
    && entry.stableKey === `approval:${approvalId}`);
  if (!interrupt) return null;
  return resolveInterrupt(interrupt.id, {
    generation: interrupt.generation,
    response: {
      approvalId,
      status: text(event?.status, 80),
      decision: text(event?.decision, 80),
      source: text(event?.source, 120),
    },
  });
}

async function resolvePrivilegedResponse(sessionId, event) {
  const batchId = safeBatchId(event);
  const category = text(event?.category, 80);
  if (!batchId || !category) return null;
  const execution = await findExecution(PRIVILEGED_SCOPE_KIND, sessionId, batchId);
  if (!execution) return null;
  const interrupt = execution.interrupts?.find((entry) => entry.state === 'open'
    && entry.stableKey === `batch:${batchId}:${category}`);
  if (!interrupt) return null;
  return resolveInterrupt(interrupt.id, {
    generation: interrupt.generation,
    response: {
      batchId,
      category,
      decisions: event?.decisions && typeof event.decisions === 'object' ? event.decisions : {},
      signedManifestHash: text(event?.signedManifestHash, 256),
    },
  });
}

/**
 * Mirror one or more already-persisted history events in sequence.  Sequencing
 * matters when a test/recovery batch contains a request followed immediately
 * by its response.  Store failures intentionally propagate to the caller;
 * history's append path invokes this fire-and-forget and logs the failure so a
 * projection outage can never reject the canonical event write.
 */
export async function mirrorApprovalEventsToOrchestration({ sessionId, events } = {}) {
  const normalizedSessionId = safeSessionId(sessionId);
  if (!normalizedSessionId) return [];
  const mirrored = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'approval_request') {
      mirrored.push(await mirrorApprovalRequest(normalizedSessionId, event));
    } else if (event?.type === 'approval_response') {
      mirrored.push(await resolveApprovalResponse(normalizedSessionId, event));
    } else if (event?.type === 'privileged_batch_request') {
      mirrored.push(...(await mirrorPrivilegedRequest(normalizedSessionId, event) || []));
    } else if (event?.type === 'privileged_batch_response') {
      mirrored.push(await resolvePrivilegedResponse(normalizedSessionId, event));
    }
  }
  return mirrored.filter(Boolean);
}

