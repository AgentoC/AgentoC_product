const MAX_FACTS = 32;
const MAX_TEXT_CHARS = 4000;
const MAX_REFS = 16;

export const WORK_STATE_FACT_KINDS = Object.freeze([
  'goal',
  'status',
  'plan',
  'decision',
  'completed_work',
  'failed_attempt',
  'blocker',
  'unresolved',
  'next_action',
]);

const FACT_KIND_SET = new Set(WORK_STATE_FACT_KINDS);
const RESOLVABLE_FACT_KINDS = new Set([
  'decision',
  'completed_work',
  'failed_attempt',
  'blocker',
  'unresolved',
]);
const STATUS_VALUES = new Set([
  'idle',
  'running',
  'ready',
  'completed',
  'failed',
  'cancelled',
  'blocked',
  'waiting',
  'resolved',
  'superseded',
]);

function text(value, maxChars = MAX_TEXT_CHARS) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n').trim().slice(0, maxChars);
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeSourceRef(value) {
  if (typeof value === 'string') {
    const ref = text(value, 240);
    return ref ? { ref } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const seq = positiveInt(value.seq);
  const runId = text(value.runId, 160);
  const eventId = text(value.eventId, 160);
  const toolExecutionId = text(value.toolExecutionId, 160);
  const ref = text(value.ref, 240);
  if (!seq && !runId && !eventId && !toolExecutionId && !ref) return null;
  return {
    ...(seq ? { seq } : {}),
    ...(runId ? { runId } : {}),
    ...(eventId ? { eventId } : {}),
    ...(toolExecutionId ? { toolExecutionId } : {}),
    ...(ref ? { ref } : {}),
  };
}

export function normalizeSourceRefs(value) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  const seen = new Set();
  const refs = [];
  for (const item of values.slice(0, MAX_REFS)) {
    const ref = normalizeSourceRef(item);
    if (!ref) continue;
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

function normalizeStatus(value, fallback = 'pending') {
  const normalized = text(value, 80).toLowerCase().replace(/[ -]+/g, '_');
  return STATUS_VALUES.has(normalized) ? normalized : fallback;
}

function normalizeList(value, maxItems = 16) {
  const values = Array.isArray(value) ? value : [];
  return values
    .slice(0, maxItems)
    .map((item) => {
      if (typeof item === 'string') return { text: text(item, 800) };
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const itemText = text(item.text || item.statement || item.title || item.name, 800);
      if (!itemText) return null;
      return {
        ...(text(item.id, 160) ? { id: text(item.id, 160) } : {}),
        text: itemText,
        ...(text(item.status, 80) ? { status: normalizeStatus(item.status) } : {}),
        sourceRefs: normalizeSourceRefs(item.sourceRefs || item.evidenceRefs),
      };
    })
    .filter(Boolean);
}

function normalizeStringList(value, maxItems = 16, maxChars = 800) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values
    .map((item) => text(typeof item === 'string' ? item : item?.text || item?.statement || item?.name, maxChars))
    .filter(Boolean))].slice(0, maxItems);
}

function normalizeOptionalIso(value) {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) return '';
  return new Date(value).toISOString();
}

function normalizePlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const planId = text(value.planId || value.id, 160);
  const steps = normalizeList(value.steps || value.items, 32).map((step, index) => ({
    id: step.id || `step-${index + 1}`,
    text: step.text,
    status: normalizeStatus(step.status, 'pending'),
    sourceRefs: step.sourceRefs,
  }));
  if (!planId && steps.length === 0) return null;
  const activeStepId = text(value.activeStepId, 160);
  return {
    ...(planId ? { planId } : {}),
    ...(Number.isInteger(value.revision) && value.revision > 0 ? { revision: value.revision } : {}),
    state: normalizeStatus(value.state || value.status, 'running'),
    steps,
    ...(activeStepId ? { activeStepId } : {}),
    sourceRefs: normalizeSourceRefs(value.sourceRefs || value.evidenceRefs),
  };
}

function normalizeFactValue(kind, value) {
  if (kind === 'status') {
    const status = normalizeStatus(typeof value === 'string' ? value : value?.status, 'running');
    return { status };
  }
  if (kind === 'plan') return normalizePlan(value);

  if (kind === 'decision') {
    const source = typeof value === 'string' ? { statement: value } : value;
    const statement = text(source?.statement || source?.text || source?.decision, 1200);
    if (!statement) return null;
    return {
      statement,
      reason: text(source?.reason || source?.rationale, 1600),
      status: normalizeStatus(source?.status, 'accepted'),
      alternativesConsidered: normalizeStringList(source?.alternativesConsidered || source?.alternatives),
      rejectedAlternatives: normalizeStringList(source?.rejectedAlternatives || source?.rejected),
      evidence: normalizeStringList(source?.evidence || source?.evidenceRefs),
      ...(text(source?.decisionOwner || source?.owner || source?.decidedBy, 240)
        ? { decisionOwner: text(source.decisionOwner || source.owner || source.decidedBy, 240) }
        : {}),
      ...(typeof source?.reversible === 'boolean' ? { reversible: source.reversible } : {}),
      ...(normalizeOptionalIso(source?.decidedAt) ? { decidedAt: normalizeOptionalIso(source.decidedAt) } : {}),
      sourceRefs: normalizeSourceRefs(source?.sourceRefs || source?.evidenceRefs),
    };
  }

  if (kind === 'failed_attempt') {
    const source = typeof value === 'string' ? { approach: value } : value;
    const approach = text(source?.approach || source?.strategy || source?.text, 1200);
    const failure = text(source?.failure || source?.error || source?.reason, 1600);
    if (!approach || !failure) return null;
    return {
      approach,
      failure,
      retryCondition: text(source?.retryCondition || source?.whenToRetry, 1000),
      rootCause: text(source?.rootCause || source?.cause, 1200),
      result: text(source?.result || source?.outcome, 1000),
      environment: text(source?.environment || source?.env, 1000),
      version: text(source?.version || source?.runtimeVersion, 240),
      status: normalizeStatus(source?.status, 'failed'),
      ...(normalizeOptionalIso(source?.attemptedAt) ? { attemptedAt: normalizeOptionalIso(source.attemptedAt) } : {}),
      sourceRefs: normalizeSourceRefs(source?.sourceRefs || source?.evidenceRefs),
    };
  }

  const source = typeof value === 'string' ? { text: value } : value;
  const itemText = text(source?.text || source?.statement || source?.action || source?.goal, 1600);
  if (!itemText) return null;
  return {
    text: itemText,
    ...(kind === 'goal' ? {} : { status: normalizeStatus(source?.status, kind === 'next_action' ? 'pending' : 'open') }),
    sourceRefs: normalizeSourceRefs(source?.sourceRefs || source?.evidenceRefs),
  };
}

export function normalizeWorkStateUpdate(input, { requireIds = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const operation = text(input.operation, 40).toLowerCase();
  const source = text(input.source || input.recordedBy, 40).toLowerCase();
  if (!['upsert', 'resolve'].includes(operation) || !['agent', 'user', 'system'].includes(source)) return null;
  const facts = [];
  for (const raw of (Array.isArray(input.facts) ? input.facts : []).slice(0, MAX_FACTS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const kind = text(raw.kind, 80).toLowerCase();
    if (!FACT_KIND_SET.has(kind)) continue;
    const id = text(raw.id, 160);
    if (requireIds && !id) continue;
    const hasValue = Object.prototype.hasOwnProperty.call(raw, 'value');
    let value = normalizeFactValue(kind, hasValue ? raw.value : raw);
    // Resolving an existing fact only needs its stable id plus provenance. Do
    // not force callers to repeat the original statement, which could itself
    // be stale or contradictory.
    if (!value && operation === 'resolve' && RESOLVABLE_FACT_KINDS.has(kind) && id) {
      value = { sourceRefs: normalizeSourceRefs(raw.sourceRefs || raw.evidenceRefs) };
    }
    if (!value) continue;
    facts.push({
      kind,
      ...(id ? { id } : {}),
      value,
      sourceRefs: normalizeSourceRefs(raw.sourceRefs || raw.evidenceRefs || value.sourceRefs),
      recordedBy: source,
    });
  }
  if (facts.length === 0) return null;
  return { operation, source, facts };
}

export function validateWorkStateUpdate(input) {
  const normalized = normalizeWorkStateUpdate(input);
  if (!normalized) {
    const error = new Error('invalid work_state_update');
    error.code = 'INVALID_WORK_STATE_UPDATE';
    throw error;
  }
  return true;
}

function sourceRefsForFact(fact, sourceSeq) {
  const refs = normalizeSourceRefs(fact.sourceRefs || fact.value?.sourceRefs);
  if (refs.length > 0 || !positiveInt(sourceSeq)) return refs;
  return [{ seq: sourceSeq }];
}

function withProvenance(value, fact, sourceSeq) {
  return {
    ...value,
    sourceRefs: sourceRefsForFact(fact, sourceSeq),
    recordedBy: fact.recordedBy,
  };
}

function upsert(items, item) {
  const index = items.findIndex((entry) => entry.id === item.id);
  if (index < 0) return [...items, item];
  const next = items.slice();
  next[index] = { ...next[index], ...item };
  return next;
}

function resolve(items, id, sourceRefs, recordedBy) {
  const index = items.findIndex((entry) => entry.id === id);
  if (index < 0) return items;
  const next = items.slice();
  next[index] = {
    ...next[index],
    status: 'resolved',
    sourceRefs: sourceRefs.length > 0 ? sourceRefs : next[index].sourceRefs,
    recordedBy,
  };
  return next;
}

export function applyWorkStateUpdate(task, update, { sourceSeq = 0 } = {}) {
  const normalized = normalizeWorkStateUpdate(update);
  if (!normalized) return task;
  let next = { ...task };
  for (const fact of normalized.facts) {
    const id = fact.id || `${fact.kind}:${sourceSeq}`;
    const value = withProvenance(fact.value, fact, sourceSeq);
    if (fact.kind === 'goal') {
      next.goal = { text: value.text, sourceRefs: value.sourceRefs, recordedBy: value.recordedBy };
    } else if (fact.kind === 'status') {
      next.status = value.status;
    } else if (fact.kind === 'plan') {
      next.plan = { ...value, planId: value.planId || id };
    } else if (fact.kind === 'next_action') {
      next.nextAction = { text: value.text, sourceRefs: value.sourceRefs, recordedBy: value.recordedBy };
    } else if (fact.kind === 'decision') {
      next.decisions = normalized.operation === 'resolve'
        ? resolve(next.decisions || [], id, value.sourceRefs, value.recordedBy)
        : upsert(next.decisions || [], { id, ...value });
    } else if (fact.kind === 'completed_work') {
      next.completedWork = normalized.operation === 'resolve'
        ? resolve(next.completedWork || [], id, value.sourceRefs, value.recordedBy)
        : upsert(next.completedWork || [], { id, ...value });
    } else if (fact.kind === 'failed_attempt') {
      next.failedAttempts = normalized.operation === 'resolve'
        ? resolve(next.failedAttempts || [], id, value.sourceRefs, value.recordedBy)
        : upsert(next.failedAttempts || [], { id, ...value });
    } else if (fact.kind === 'blocker') {
      next.blockers = normalized.operation === 'resolve'
        ? resolve(next.blockers || [], id, value.sourceRefs, value.recordedBy)
        : upsert(next.blockers || [], { id, ...value });
    } else if (fact.kind === 'unresolved') {
      next.unresolved = normalized.operation === 'resolve'
        ? resolve(next.unresolved || [], id, value.sourceRefs, value.recordedBy)
        : upsert(next.unresolved || [], { id, ...value });
    }
  }
  return next;
}

export function buildTaskStateFromLegacy(state = {}) {
  const objectiveText = text(state.objective?.raw || state.objective?.text || state.objective);
  return {
    goal: objectiveText
      ? { text: objectiveText, sourceRefs: positiveInt(state.objective?.sourceSeq) ? [{ seq: state.objective.sourceSeq }] : [] }
      : null,
    status: normalizeStatus(state.status, 'idle'),
    plan: null,
    decisions: Array.isArray(state.decisions) ? state.decisions : [],
    completedWork: [],
    failedAttempts: [],
    blockers: Array.isArray(state.blockers) ? state.blockers : [],
    unresolved: [],
    nextAction: state.nextAction
      ? { text: text(typeof state.nextAction === 'string' ? state.nextAction : state.nextAction.text), sourceRefs: [] }
      : null,
  };
}
