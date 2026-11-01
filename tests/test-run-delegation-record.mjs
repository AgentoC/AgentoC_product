#!/usr/bin/env node
import assert from 'assert/strict';

import {
  buildDelegationIdentity,
  normalizeDelegationEvent,
} from '../chat/delegation-canonical.mjs';
import {
  RUN_DELEGATION_RECORD_SCHEMA_VERSION,
  RunDelegationRecordError,
  migrateRunDelegationRecord,
  normalizeRunDelegationRecord,
  reduceRunDelegationRecord,
  summarizeRunDelegationRecords,
  validateRunDelegationRecord,
} from '../chat/run-delegation-record.mjs';

function id(provider, providerDelegationId, runId) {
  return buildDelegationIdentity({ provider, providerDelegationId, runId }).id;
}

// Mint canonical events via the frozen contract helpers.
function makeEvent(fields) {
  return normalizeDelegationEvent({
    provider: 'claude',
    providerDelegationId: 'sub_1',
    runId: 'run_1',
    parentSessionId: 'sess_parent',
    childSessionId: 'sess_child',
    ...fields,
  });
}

function makeEventFor(sub, child, fields) {
  return normalizeDelegationEvent({
    provider: 'claude',
    providerDelegationId: sub,
    runId: 'run_1',
    parentSessionId: 'sess_parent',
    childSessionId: child,
    ...fields,
  });
}

const DELG = id('claude', 'sub_1', 'run_1');

assert.equal(RUN_DELEGATION_RECORD_SCHEMA_VERSION, 1);

// --- seed only on 'spawned'; ignore pre-spawn -----------------------------------
assert.equal(
  reduceRunDelegationRecord(null, makeEvent({ kind: 'running', state: 'running', seq: 1, timestamp: 1 })),
  null,
  'pre-spawn running event must not seed a record',
);
assert.equal(
  reduceRunDelegationRecord(null, makeEvent({ kind: 'snapshot', state: 'running', seq: 1, timestamp: 1 })),
  null,
  'pre-spawn snapshot event must not seed a record',
);

const spawned = reduceRunDelegationRecord(
  null,
  makeEvent({ kind: 'spawned', state: 'spawned', seq: 1, timestamp: 10 }),
);
assert.equal(spawned.schemaVersion, 1);
assert.equal(spawned.delegationId, DELG);
assert.equal(spawned.provider, 'claude');
assert.equal(spawned.runId, 'run_1');
assert.equal(spawned.parentSessionId, 'sess_parent');
assert.equal(spawned.childSessionId, 'sess_child');
assert.equal(spawned.state, 'spawned');
assert.equal(spawned.generation, 1);
assert.equal(spawned.stateVersion, 1);
assert.equal(spawned.lastEventAt, 10);
assert.equal(spawned.terminatedAt, null);
assert.equal(Object.isFrozen(spawned), true, 'seeded record must be frozen');

// --- generation strictly increases; stateVersion === last applied seq -----------
let record = spawned;
const progress = [
  { kind: 'running', state: 'running', seq: 2, timestamp: 20 },
  { kind: 'waiting', state: 'waiting', seq: 3, timestamp: 30 },
  { kind: 'running', state: 'running', seq: 4, timestamp: 40 },
];
for (const step of progress) {
  const prevGen = record.generation;
  record = reduceRunDelegationRecord(record, makeEvent(step));
  assert.ok(record.generation > prevGen, 'generation must strictly increase');
  assert.equal(record.stateVersion, step.seq, 'stateVersion === last applied seq');
  assert.equal(record.state, step.state);
  assert.equal(record.lastEventAt, step.timestamp);
  assert.equal(record.terminatedAt, null, 'active state has no terminatedAt');
}
assert.equal(record.generation, 4);

// --- terminal state sets terminatedAt; later non-recovery event NOT applied -----
const completed = reduceRunDelegationRecord(
  record,
  makeEvent({ kind: 'completed', state: 'completed', seq: 5, timestamp: 5000 }),
);
assert.equal(completed.state, 'completed');
assert.equal(completed.terminatedAt, 5000, 'terminal state sets terminatedAt');
assert.equal(completed.generation, 5);
assert.equal(completed.stateVersion, 5);

// A later non-recovery event for a terminal-but-not-lost record is NOT applied
// (the same record reference is returned unchanged).
const ignored = reduceRunDelegationRecord(
  completed,
  makeEvent({ kind: 'running', state: 'running', seq: 6, timestamp: 6000 }),
);
assert.equal(ignored, completed, 'terminal-but-not-lost record must ignore further events');
assert.equal(ignored.state, 'completed');
assert.equal(ignored.generation, 5);
assert.equal(ignored.stateVersion, 5);
assert.equal(ignored.terminatedAt, 5000);

// --- 'recovered' on a lost record returns running and clears terminatedAt --------
let lost = reduceRunDelegationRecord(
  null,
  makeEventFor('sub_2', 'sess_child_2', { kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 }),
);
lost = reduceRunDelegationRecord(lost, makeEventFor('sub_2', 'sess_child_2', { kind: 'running', state: 'running', seq: 2, timestamp: 2 }));
lost = reduceRunDelegationRecord(lost, makeEventFor('sub_2', 'sess_child_2', { kind: 'lost', state: 'lost', seq: 3, timestamp: 3000 }));
assert.equal(lost.state, 'lost');
assert.equal(lost.terminatedAt, 3000);

// A non-recovery event on a lost record is NOT applied (only the recovery arc).
const lostIgnored = reduceRunDelegationRecord(
  lost,
  makeEventFor('sub_2', 'sess_child_2', { kind: 'running', state: 'running', seq: 4, timestamp: 4 }),
);
assert.equal(lostIgnored, lost, 'lost record must ignore non-recovery events');
assert.equal(lostIgnored.state, 'lost');

// 'recovered' on a lost record returns state running and clears terminatedAt.
const recovered = reduceRunDelegationRecord(
  lost,
  makeEventFor('sub_2', 'sess_child_2', { kind: 'recovered', state: 'running', seq: 5, timestamp: 5000 }),
);
assert.equal(recovered.state, 'running');
assert.equal(recovered.terminatedAt, null, 'recovery clears terminatedAt');
assert.equal(recovered.generation, lost.generation + 1);
assert.equal(recovered.stateVersion, 5);
assert.equal(recovered.lastEventAt, 5000);

// --- incremental fold === bulk fold (deepEqual) ---------------------------------
const foldEvents = [
  makeEvent({ kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 }),
  makeEvent({ kind: 'running', state: 'running', seq: 2, timestamp: 2 }),
  makeEvent({ kind: 'waiting', state: 'waiting', seq: 3, timestamp: 3 }),
  makeEvent({ kind: 'running', state: 'running', seq: 4, timestamp: 4 }),
  makeEvent({ kind: 'completed', state: 'completed', seq: 5, timestamp: 5 }),
];
// Incremental fold, simulating persist + reload (JSON round-trip) between events
// to prove the record is a clean, serializable fold state.
let incremental = null;
for (const event of foldEvents) {
  incremental = reduceRunDelegationRecord(incremental, event);
  incremental = JSON.parse(JSON.stringify(incremental));
}
// Bulk fold.
const bulk = foldEvents.reduce(reduceRunDelegationRecord, null);
assert.deepEqual(incremental, bulk, 'incremental fold must equal bulk fold');

// --- summarize counts active / lost / terminal ----------------------------------
const sActive = reduceRunDelegationRecord(
  null,
  normalizeDelegationEvent({
    provider: 'claude', providerDelegationId: 'sa', runId: 'run_s', parentSessionId: 'p',
    kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1,
  }),
);
const sLost = reduceRunDelegationRecord(
  reduceRunDelegationRecord(null, normalizeDelegationEvent({
    provider: 'claude', providerDelegationId: 'sl', runId: 'run_s', parentSessionId: 'p',
    kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1,
  })),
  normalizeDelegationEvent({
    provider: 'claude', providerDelegationId: 'sl', runId: 'run_s', parentSessionId: 'p',
    kind: 'lost', state: 'lost', seq: 2, timestamp: 2,
  }),
);
const sDone = reduceRunDelegationRecord(
  reduceRunDelegationRecord(null, normalizeDelegationEvent({
    provider: 'claude', providerDelegationId: 'sd', runId: 'run_s', parentSessionId: 'p',
    kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1,
  })),
  normalizeDelegationEvent({
    provider: 'claude', providerDelegationId: 'sd', runId: 'run_s', parentSessionId: 'p',
    kind: 'completed', state: 'completed', seq: 2, timestamp: 2,
  }),
);
const summary = summarizeRunDelegationRecords([sActive, sLost, sDone]);
assert.equal(summary.total, 3);
assert.equal(summary.active, 1);
assert.equal(summary.lost, 1);
assert.equal(summary.terminal, 1);
assert.equal(summary.activeDelegations, summary.active, 'activeDelegations === active count');
assert.equal(Object.isFrozen(summary), true);

// --- validate fails closed on forbidden fields ----------------------------------
const baseRecord = {
  schemaVersion: 1,
  delegationId: DELG,
  provider: 'claude',
  providerDelegationId: 'sub_1',
  runId: 'run_1',
  parentSessionId: 'sess_parent',
  state: 'running',
  generation: 1,
  stateVersion: 1,
  lastEventAt: 1,
  terminatedAt: null,
};
assert.deepEqual(validateRunDelegationRecord(baseRecord), { ok: true, errors: [] });

const withSecret = validateRunDelegationRecord({ ...baseRecord, secret: 'x' });
assert.equal(withSecret.ok, false);
assert.ok(withSecret.errors.some((e) => e.includes('forbidden fields')), `unexpected: ${withSecret.errors.join('; ')}`);

const withRawPayload = validateRunDelegationRecord({ ...baseRecord, raw_payload: {} });
assert.equal(withRawPayload.ok, false);
assert.ok(withRawPayload.errors.some((e) => e.includes('forbidden fields')), `unexpected: ${withRawPayload.errors.join('; ')}`);

// --- normalize freezes the object (and strips forbidden fields) ------------------
const normalized = normalizeRunDelegationRecord(baseRecord);
assert.equal(Object.isFrozen(normalized), true);
assert.equal(normalized.state, 'running');
assert.deepEqual(validateRunDelegationRecord(normalized), { ok: true, errors: [] });

const cleaned = normalizeRunDelegationRecord({ ...baseRecord, secret: 'x', token: 'leak' });
assert.equal(Object.isFrozen(cleaned), true);
assert.equal(Object.hasOwn(cleaned, 'secret'), false, 'normalize must strip forbidden fields');
assert.equal(Object.hasOwn(cleaned, 'token'), false, 'normalize must strip forbidden fields');
assert.deepEqual(validateRunDelegationRecord(cleaned), { ok: true, errors: [] });

assert.throws(
  () => normalizeRunDelegationRecord({ ...baseRecord, state: 'bogus' }),
  (error) => error instanceof RunDelegationRecordError && error.code === 'RUN_DELEGATION_RECORD',
);

// --- migrate rejects schemaVersion 2 --------------------------------------------
assert.equal(migrateRunDelegationRecord(baseRecord), baseRecord, 'v1 record is returned unchanged');
assert.throws(
  () => migrateRunDelegationRecord({ ...baseRecord, schemaVersion: 2 }),
  (error) => error instanceof RunDelegationRecordError && error.code === 'RUN_DELEGATION_RECORD',
);

// --- determinism: projection built twice from same events is identical ----------
const detEvents = [
  makeEvent({ kind: 'spawned', state: 'spawned', seq: 1, timestamp: 1 }),
  makeEvent({ kind: 'running', state: 'running', seq: 2, timestamp: 2 }),
  makeEvent({ kind: 'lost', state: 'lost', seq: 3, timestamp: 3 }),
  makeEvent({ kind: 'recovered', state: 'running', seq: 4, timestamp: 4 }),
  makeEvent({ kind: 'completed', state: 'completed', seq: 5, timestamp: 5 }),
];
const run1 = detEvents.reduce(reduceRunDelegationRecord, null);
const run2 = detEvents.reduce(reduceRunDelegationRecord, null);
assert.deepEqual(run1, run2, 'projection must be deterministic');
assert.equal(JSON.stringify(run1), JSON.stringify(run2), 'projection must be byte-identical');
assert.equal(run1.state, 'completed');
assert.equal(run1.terminatedAt, 5);

console.log('test-run-delegation-record: ok');
