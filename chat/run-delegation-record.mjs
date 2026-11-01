/**
 * RunDelegation v1 record — rebuildable per-delegation projection.
 *
 * This module folds canonical DelegationEvents (see `delegation-canonical.mjs`)
 * into a single durable, versioned, per-delegation RECORD. It is a pure,
 * deterministic, side-effect-free projection: given the same event stream it
 * always produces byte-identical output, and the record can be rebuilt from
 * scratch at any time by replaying the canonical history.
 *
 * It is NOT a second source of truth. The canonical event history remains the
 * authoritative fact source; this record is a rebuildable view of it.
 *
 * Non-negotiable contract:
 *   - Pure fold: incremental fold === bulk fold === identical bytes. No IO, no
 *     wall-clock, no randomness.
 *   - Secrets / provider raw payload / credentials / hidden context never enter
 *     a record. Validation fails closed on any forbidden field.
 *   - Versioned schema (schemaVersion). Future versions are rejected by the
 *     migrator until an explicit migration path exists.
 *   - No provider-private field names; the record is provider-agnostic.
 */

import {
  DELEGATION_STATES,
  isDelegationActive,
  isDelegationTerminal,
} from './delegation-canonical.mjs';

export const RUN_DELEGATION_RECORD_SCHEMA_VERSION = 1;

const STATE_SET = new Set(DELEGATION_STATES);

// Permanently terminal states (no recovery arc). `lost` is terminal too, but it
// is the one state with a recovery arc, so it is handled separately.
const TERMINAL_NON_LOST_SET = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

// Canonical transitions allowed out of the `lost` state: the single recovery
// arc (`recovered` -> running) plus a declared failure or a re-declared loss.
const LOST_EXIT_KINDS = new Set(['recovered', 'failed', 'lost']);

// Exact replica of the card-specified forbidden-field regex. A record must
// never carry provider raw payload, credentials, or hidden/internal context.
// Anchored at the start so a key that merely *contains* a forbidden substring
// (e.g. "mytoken") is not rejected; only keys that *start* with one are.
const FORBIDDEN_FIELD = /^(?:raw[_-]?payload|raw|payload|access[_-]?token|token|secret|api[_-]?key|password|passwd|authorization|cookie|credential|hidden[_-]?context|hidden|internal|private|__|_)/i;

export class RunDelegationRecordError extends Error {
  constructor(errors) {
    super(`run delegation record violation: ${errors.join('; ')}`);
    this.name = 'RunDelegationRecordError';
    this.code = 'RUN_DELEGATION_RECORD';
    this.errors = errors;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function collectForbiddenFields(value, prefix = '', depth = 0, found = []) {
  if (depth > 10 || !isObject(value)) return found;
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (FORBIDDEN_FIELD.test(key)) {
      found.push(path);
      continue;
    }
    collectForbiddenFields(item, path, depth + 1, found);
  }
  return found;
}

function stripForbidden(value, depth = 0) {
  if (depth > 10) return undefined;
  if (Array.isArray(value)) return value.map((item) => stripForbidden(item, depth + 1));
  if (!isObject(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_FIELD.test(key)) continue;
    out[key] = stripForbidden(item, depth + 1);
  }
  return out;
}

// Target state of a canonical event. `recovered` targets `running`; `snapshot`
// is neutral (handled by the caller, which preserves the current state); every
// other kind targets its own state.
function eventTargetState(event) {
  if (event.kind === 'recovered') return 'running';
  return event.state;
}

// Immutable identity bindings, refreshed defensively from each applied event
// (they are constant per delegation, and materialized fields like
// `childSessionId` may appear on a later event).
function pickIdentityFields(event) {
  return {
    provider: event.provider,
    providerDelegationId: event.providerDelegationId,
    runId: event.runId,
    parentRunId: event.runId,
    parentSessionId: event.parentSessionId,
    ...(event.parentDelegationId ? { parentDelegationId: event.parentDelegationId } : {}),
    ...(event.childSessionId ? { childSessionId: event.childSessionId } : {}),
  };
}

function seedRecord(event) {
  return Object.freeze({
    schemaVersion: RUN_DELEGATION_RECORD_SCHEMA_VERSION,
    delegationId: event.delegationId,
    ...pickIdentityFields(event),
    state: 'spawned',
    generation: 1,
    stateVersion: event.seq,
    providerRefs: {
      providerDelegationId: event.providerDelegationId,
      ...(event.childSessionId ? { childSessionId: event.childSessionId } : {}),
    },
    execution: {
      ownership: 'provider_native',
      recoverability: 'parent_process_bound',
    },
    currentAction: 'spawned',
    lastToolName: null,
    startedAt: event.timestamp,
    updatedAt: event.timestamp,
    completedAt: null,
    usage: null,
    result: null,
    lastEventAt: event.timestamp,
    terminatedAt: null,
    ...(event.facts ? { facts: event.facts } : {}),
  });
}

// Whether an event should be applied to an existing record. Ignored events are
// returned unchanged so the fold stays a pure, deterministic projection.
function shouldApply(prev, event) {
  if (event.kind === 'spawned') return false; // duplicate identity on an existing record
  if (event.kind === 'recovered' && prev.state !== 'lost') return false; // recovery only from lost
  if (TERMINAL_NON_LOST_SET.has(prev.state)) return false; // permanently frozen
  if (prev.state === 'lost') return LOST_EXIT_KINDS.has(event.kind); // only the lost exit arc
  return true; // active record accepts progress / snapshot events
}

function applyEvent(prev, event) {
  // `snapshot` is neutral: it carries the current state, so preserve state and
  // only advance the counters, last-event time, and facts.
  const newState = event.kind === 'snapshot' ? prev.state : eventTargetState(event);
  return Object.freeze({
    ...prev,
    ...pickIdentityFields(event),
    state: newState,
    generation: prev.generation + 1,
    stateVersion: event.seq,
    providerRefs: {
      ...(prev.providerRefs || {}),
      providerDelegationId: event.providerDelegationId,
      ...(event.childSessionId ? { childSessionId: event.childSessionId } : {}),
    },
    execution: prev.execution || {
      ownership: 'provider_native',
      recoverability: 'parent_process_bound',
    },
    currentAction: event.kind,
    lastToolName: event.facts?.toolName || prev.lastToolName || null,
    startedAt: prev.startedAt || event.timestamp,
    updatedAt: event.timestamp,
    completedAt: isDelegationTerminal(newState) ? event.timestamp : null,
    usage: event.facts?.usage || prev.usage || null,
    result: event.facts?.candidate || prev.result || null,
    lastEventAt: event.timestamp,
    terminatedAt: isDelegationTerminal(newState) ? event.timestamp : null,
    ...(event.facts ? { facts: event.facts } : {}),
  });
}

/**
 * Pure per-delegation fold. Returns a new frozen record, or the previous record
 * unchanged when the event is ignored (pre-spawn, wrong delegation, or a
 * terminal record that accepts no further events). Pass `null` as the initial
 * accumulator.
 */
export function reduceRunDelegationRecord(prev, event) {
  const hasRecord = prev !== null && prev !== undefined;
  if (!isObject(event)) return hasRecord ? prev : null;
  if (!hasRecord) {
    // Seed only on the first `spawned` for this delegation; ignore pre-spawn.
    return event.kind === 'spawned' ? seedRecord(event) : null;
  }
  if (!isObject(prev)) return prev;
  // A multi-delegation stream folds each delegation independently: events for a
  // different delegation leave this record unchanged.
  if (event.delegationId !== prev.delegationId) return prev;
  if (!shouldApply(prev, event)) return prev;
  return applyEvent(prev, event);
}

/**
 * Summarize a collection of records into active / lost / terminal counts.
 * `lost` is reported in its own bucket (it is terminal but recoverable);
 * `terminal` counts only the permanently-terminal outcomes. `activeDelegations`
 * is the count of active records.
 */
export function summarizeRunDelegationRecords(records = []) {
  const list = Array.isArray(records) ? records : [];
  let active = 0;
  let lost = 0;
  let terminal = 0;
  let total = 0;
  for (const record of list) {
    if (!isObject(record)) continue;
    total += 1;
    if (record.state === 'lost') lost += 1;
    else if (isDelegationTerminal(record.state)) terminal += 1;
    else if (isDelegationActive(record.state)) active += 1;
  }
  return Object.freeze({ total, active, lost, terminal, activeDelegations: active });
}

/**
 * Validate a record. Returns `{ ok, errors }` and fails closed when a forbidden
 * field (raw payload / token / secret / hidden context) is present.
 */
export function validateRunDelegationRecord(input) {
  if (!isObject(input)) {
    return { ok: false, errors: ['record must be an object'] };
  }
  const errors = [];

  if (input.schemaVersion !== RUN_DELEGATION_RECORD_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${RUN_DELEGATION_RECORD_SCHEMA_VERSION}`);
  }

  const delegationId = typeof input.delegationId === 'string' ? input.delegationId.trim() : '';
  if (!delegationId) {
    errors.push('delegationId is required');
  } else if (!/^delg_[a-f0-9]{20}$/.test(delegationId)) {
    errors.push('delegationId must be a canonical delegation id');
  }

  for (const field of ['provider', 'providerDelegationId', 'runId', 'parentSessionId']) {
    if (typeof input[field] !== 'string' || !input[field].trim()) {
      errors.push(`${field} is required`);
    }
  }

  if (input.parentDelegationId !== undefined && input.parentDelegationId !== null) {
    if (!/^delg_[a-f0-9]{20}$/.test(String(input.parentDelegationId).trim())) {
      errors.push('parentDelegationId must be a canonical delegation id when present');
    }
  }
  if (input.childSessionId !== undefined && input.childSessionId !== null) {
    if (typeof input.childSessionId !== 'string' || !input.childSessionId.trim()) {
      errors.push('childSessionId must be a non-empty string when present');
    }
  }

  if (!STATE_SET.has(input.state)) {
    errors.push(`state must be one of: ${DELEGATION_STATES.join(', ')}`);
  }
  if (!isPositiveInt(input.generation)) errors.push('generation must be a positive integer');
  if (!isPositiveInt(input.stateVersion)) errors.push('stateVersion must be a positive integer');
  if (input.providerRefs !== undefined && !isObject(input.providerRefs)) errors.push('providerRefs must be an object');
  if (input.execution !== undefined && !isObject(input.execution)) errors.push('execution must be an object');
  if (input.execution && input.execution.ownership !== 'provider_native') {
    errors.push("execution.ownership must be 'provider_native'");
  }
  if (input.execution && input.execution.recoverability !== 'parent_process_bound') {
    errors.push("execution.recoverability must be 'parent_process_bound'");
  }
  if (input.currentAction !== undefined && (typeof input.currentAction !== 'string' || !input.currentAction.trim())) {
    errors.push('currentAction is required');
  }
  if (input.lastToolName !== null && input.lastToolName !== undefined && typeof input.lastToolName !== 'string') {
    errors.push('lastToolName must be a string or null');
  }
  for (const field of ['startedAt', 'updatedAt']) {
    if (input[field] !== undefined && !isPositiveNumber(input[field])) errors.push(`${field} must be a positive number`);
  }
  if (input.completedAt !== null && input.completedAt !== undefined && !isPositiveNumber(input.completedAt)) {
    errors.push('completedAt must be null or a positive number');
  }
  if (!isPositiveNumber(input.lastEventAt)) errors.push('lastEventAt must be a positive number');
  if (input.terminatedAt !== null && input.terminatedAt !== undefined && !isPositiveNumber(input.terminatedAt)) {
    errors.push('terminatedAt must be null or a positive number');
  }

  const forbidden = collectForbiddenFields(input);
  if (forbidden.length > 0) {
    errors.push(`forbidden fields must not enter a record: ${forbidden.join(', ')}`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Normalize a record-like input: strip forbidden fields, project onto the
 * canonical record shape, validate, and freeze. Throws `RunDelegationRecordError`
 * on validation failure.
 */
export function normalizeRunDelegationRecord(input) {
  if (!isObject(input)) {
    throw new RunDelegationRecordError(['record must be an object']);
  }
  const cleaned = stripForbidden(input);
  const record = {
    schemaVersion: RUN_DELEGATION_RECORD_SCHEMA_VERSION,
    delegationId: cleaned.delegationId,
    provider: cleaned.provider,
    providerDelegationId: cleaned.providerDelegationId,
    runId: cleaned.runId,
    parentRunId: cleaned.parentRunId || cleaned.runId,
    parentSessionId: cleaned.parentSessionId,
    ...(cleaned.parentDelegationId ? { parentDelegationId: cleaned.parentDelegationId } : {}),
    ...(cleaned.childSessionId ? { childSessionId: cleaned.childSessionId } : {}),
    state: cleaned.state,
    generation: cleaned.generation,
    stateVersion: cleaned.stateVersion,
    providerRefs: cleaned.providerRefs || {
      providerDelegationId: cleaned.providerDelegationId,
      ...(cleaned.childSessionId ? { childSessionId: cleaned.childSessionId } : {}),
    },
    execution: cleaned.execution || {
      ownership: 'provider_native',
      recoverability: 'parent_process_bound',
    },
    currentAction: cleaned.currentAction || cleaned.state,
    lastToolName: cleaned.lastToolName === undefined ? null : cleaned.lastToolName,
    startedAt: cleaned.startedAt === undefined ? cleaned.lastEventAt : cleaned.startedAt,
    updatedAt: cleaned.updatedAt === undefined ? cleaned.lastEventAt : cleaned.updatedAt,
    completedAt: cleaned.completedAt === undefined ? null : cleaned.completedAt,
    usage: cleaned.usage === undefined ? null : cleaned.usage,
    result: cleaned.result === undefined ? null : cleaned.result,
    lastEventAt: cleaned.lastEventAt,
    terminatedAt: cleaned.terminatedAt === undefined ? null : cleaned.terminatedAt,
    ...(cleaned.facts ? { facts: cleaned.facts } : {}),
  };
  const result = validateRunDelegationRecord(record);
  if (!result.ok) throw new RunDelegationRecordError(result.errors);
  return Object.freeze(record);
}

/**
 * Migrate a record to the current schema version. v1 is the first version, so a
 * v1 record is returned unchanged; any other (e.g. future) schemaVersion is
 * rejected because no forward/backward migration path exists yet.
 */
export function migrateRunDelegationRecord(input) {
  if (!isObject(input)) {
    throw new RunDelegationRecordError(['record must be an object']);
  }
  if (input.schemaVersion === RUN_DELEGATION_RECORD_SCHEMA_VERSION) {
    return input;
  }
  throw new RunDelegationRecordError([
    `unsupported schemaVersion ${String(input.schemaVersion)}: no migration path to ${RUN_DELEGATION_RECORD_SCHEMA_VERSION}`,
  ]);
}
