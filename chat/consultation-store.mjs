// P1-T4: Consultation persistence foundation.
//
// This module owns the four consultation domain tables (consultation_rounds,
// consultation_decision_records, consultation_expert_assignments,
// consultation_packet_links). They live in the same SQLite file as the
// organization/collaboration domains (CHAT_COLLABORATIONS_DB via
// chat/collaboration-store.mjs), so a round, its decision records, expert
// assignments and packet links can commit with collaboration facts in one
// transaction.
//
// Scope of this slice: schema, the frozen 8-state round vocabulary, and the
// error codes this domain owns. CRUD, the state machine, quorum aggregation
// and deadline handling are P2 (consultation store state machine).
import { createHash, randomBytes } from 'crypto';
import {
  openDatabase as openCollaborationDatabase,
  withDatabase as withCollaborationDatabase,
} from './collaboration-store.mjs';
import { getResultPacket, CONSULTATION_PACKET_INVALID } from './result-packets.mjs';

// ── Error codes owned by the consultation domain (§6 of the plan) ────────────
// Other consultation codes (CONSULTATION_BUDGET_EXCEEDED → organization-governor,
// CONSULTATION_READONLY_VIOLATION → collaboration-plan, CONSULTATION_PACKET_INVALID
// → result-packets, CONSULTATION_LINEAGE_INCOMPLETE → managed-input) are defined
// by their owning modules and intentionally not re-declared here.
export const CONSULTATION_NOT_FOUND = 'CONSULTATION_NOT_FOUND';
export const CONSULTATION_ROUND_STATE_INVALID = 'CONSULTATION_ROUND_STATE_INVALID';
export const CONSULTATION_ROUND_STATE_CONFLICT = 'CONSULTATION_ROUND_STATE_CONFLICT';
export const CONSULTATION_QUORUM_NOT_MET = 'CONSULTATION_QUORUM_NOT_MET';
export const CONSULTATION_DEADLINE_EXPIRED = 'CONSULTATION_DEADLINE_EXPIRED';
export const CONSULTATION_EXPERT_ASSIGNMENT_INVALID = 'CONSULTATION_EXPERT_ASSIGNMENT_INVALID';
export const CONSULTATION_GUARD_INVALID = 'CONSULTATION_GUARD_INVALID';
export const CONSULTATION_DECISION_INVALID = 'CONSULTATION_DECISION_INVALID';

// C5: frozen 8-state vocabulary for a consultation round. The P2 state machine
// moves a round across these states; this array is the canonical domain
// vocabulary (states are domain words, UPPER_SNAKE).
export const CONSULTATION_ROUND_STATES = Object.freeze([
  'PLANNED', 'DISPATCHED', 'AGGREGATING', 'DECIDED',
  'INCONCLUSIVE', 'FAILED', 'EXPIRED', 'CANCELLED',
]);

function nowIso() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

// §5 of the plan: the four consultation tables. WAL and foreign_keys are already
// enabled by the shared collaboration opener. Idempotent additive — safe to run
// on every connection.
export function ensureConsultationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consultation_rounds (
      id TEXT PRIMARY KEY,
      root_session_id TEXT NOT NULL,
      round_number INTEGER NOT NULL,
      state TEXT NOT NULL,
      objective TEXT NOT NULL,
      question TEXT NOT NULL,
      quorum INTEGER NOT NULL,
      budget_json TEXT NOT NULL,
      deadline TEXT NOT NULL,
      decided_decision_record_id TEXT,
      failure_kind TEXT,
      failure_reason TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(root_session_id, round_number)
    );
    CREATE TABLE IF NOT EXISTS consultation_decision_records (
      id TEXT PRIMARY KEY,
      round_id TEXT NOT NULL REFERENCES consultation_rounds(id) ON DELETE CASCADE,
      decision TEXT NOT NULL,
      rationale TEXT,
      required_guards_json TEXT NOT NULL,
      decided_by_session_id TEXT NOT NULL,
      decided_by_node_id TEXT,
      base_revision INTEGER,
      context_digest TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS consultation_expert_assignments (
      id TEXT PRIMARY KEY,
      round_id TEXT NOT NULL REFERENCES consultation_rounds(id) ON DELETE CASCADE,
      expert_session_id TEXT,
      attempt_id TEXT,
      role TEXT NOT NULL,
      writable_paths_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS consultation_packet_links (
      round_id TEXT NOT NULL REFERENCES consultation_rounds(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL,
      packet_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (round_id, attempt_id, packet_id)
    );
    CREATE INDEX IF NOT EXISTS idx_consultation_decisions_round
      ON consultation_decision_records(round_id);
    CREATE INDEX IF NOT EXISTS idx_consultation_experts_round
      ON consultation_expert_assignments(round_id);
  `);
  // P2 additive columns (idempotent for stores created before this slice, same
  // convention as the C3 collaboration_tasks migration). attempt_id binds a
  // dispatched expert to its Attempt so aggregation can map a packet link back
  // to the expert that produced it; failure_kind/reason persist the partial-
  // failure cause so recoverConsultationRound can gate on the retry whitelist.
  const roundColumns = new Set(db.prepare('PRAGMA table_info(consultation_rounds)').all().map((column) => column.name));
  if (!roundColumns.has('failure_kind')) {
    db.exec('ALTER TABLE consultation_rounds ADD COLUMN failure_kind TEXT');
  }
  if (!roundColumns.has('failure_reason')) {
    db.exec('ALTER TABLE consultation_rounds ADD COLUMN failure_reason TEXT');
  }
  const expertColumns = new Set(db.prepare('PRAGMA table_info(consultation_expert_assignments)').all().map((column) => column.name));
  if (!expertColumns.has('attempt_id')) {
    db.exec('ALTER TABLE consultation_expert_assignments ADD COLUMN attempt_id TEXT');
  }
  // C6 additive column (idempotent, same convention as above): an explicit
  // invalidation condition for tactical decisions that carry baseRevision but
  // no context_digest (P4-T2 / P6-T1). '[]' columns are tolerated by the schema
  // contract test which asserts a lower bound, not an exact set.
  const decisionColumns = new Set(db.prepare('PRAGMA table_info(consultation_decision_records)').all().map((column) => column.name));
  if (!decisionColumns.has('expires_at')) {
    db.exec('ALTER TABLE consultation_decision_records ADD COLUMN expires_at TEXT');
  }
}

// Open the shared collaboration database and layer the consultation schema on
// top. New connections are cheap in SQLite; this keeps one canonical opener for
// the shared file instead of two handles.
export function openDatabase() {
  const db = openCollaborationDatabase();
  ensureConsultationSchema(db);
  return db;
}

// withDatabase wrapper that guarantees the consultation schema exists before the
// callback runs. Mutations ride collaboration-store's serial queue so
// consultation writes serialize with collaboration writes on the same file.
export async function withDatabase(fn, { mutate = false } = {}) {
  return withCollaborationDatabase((db) => {
    ensureConsultationSchema(db);
    return fn(db);
  }, { mutate });
}

// Ensure the consultation tables exist on first use. Mirrors
// initializeCollaborationStore / initializeOrganizationGovernor so callers have
// one entry point to materialize the shared schema.
export async function initializeConsultationStore() {
  await withDatabase(() => true, { mutate: true });
  return true;
}

// ── P2-T1: ConsultationRound CRUD + C5 state machine ─────────────────────────

// C5 frozen legal transition set. Rows are the source state; values are the
// only states reachable from it. Terminal states (DECIDED / INCONCLUSIVE /
// FAILED / EXPIRED / CANCELLED) have no outgoing transitions.
// recoverConsultationRound is the single gated exception: it moves FAILED →
// DISPATCHED only when the persisted failureKind is in the retry whitelist.
export const CONSULTATION_LEGAL_TRANSITIONS = Object.freeze({
  PLANNED: Object.freeze(['DISPATCHED', 'CANCELLED']),
  DISPATCHED: Object.freeze(['AGGREGATING', 'FAILED', 'EXPIRED', 'CANCELLED']),
  AGGREGATING: Object.freeze(['DECIDED', 'INCONCLUSIVE', 'FAILED', 'EXPIRED', 'CANCELLED']),
  DECIDED: Object.freeze([]),
  INCONCLUSIVE: Object.freeze([]),
  FAILED: Object.freeze([]),
  EXPIRED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
});

// Consultation attempt failure kinds that permit recovering a FAILED round back
// to DISPATCHED. Mirrors the collaboration retry convention (transient /
// lease-expiry style outcomes) while keeping the consultation vocabulary
// explicit. Anything outside this list is a hard failure → the round stays
// FAILED and recoverConsultationRound rejects it.
export const RETRYABLE_CONSULTATION_FAILURE_KINDS = Object.freeze([
  'retryable_attempt_failure',
  'attempt_lease_expired',
]);

function consultError(code, message, statusCode = 409, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

function json(value, fallback = null) {
  try { return JSON.stringify(value ?? fallback); } catch { return JSON.stringify(fallback); }
}

function parseJson(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function isValidIso(value) {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(new Date(value).getTime());
}

// Canonical stable JSON (sorted keys, no undefined) so identical structured
// recommendations hash identically regardless of construction order.
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

// ── C6: typed guard parsing & validation ─────────────────────────────────────

// Canonical typed guard vocabulary (§3 C6). Each guard declares its accepted
// params with defaults and a validator; anything outside this set — an unknown
// guard type, an unknown param, or an illegal param value — raises
// CONSULTATION_GUARD_INVALID(400). Exported for the P5 compiler gate to reuse.
const TYPED_GUARD_SPECS = Object.freeze({
  independent_reviewer: Object.freeze({
    params: Object.freeze({
      role: { default: 'security', validate: (value) => typeof value === 'string' && value.trim() !== '' },
      min: { default: 1, validate: (value) => Number.isInteger(value) && value >= 1 },
    }),
  }),
  execution_isolation: Object.freeze({
    params: Object.freeze({
      selector: { default: 'writers', validate: (value) => value === 'writers' },
      value: { default: 'worktree', validate: (value) => value === 'worktree' },
    }),
  }),
  max_concurrent_writers: Object.freeze({
    params: Object.freeze({
      value: { default: 1, validate: (value) => Number.isInteger(value) && value >= 1 },
    }),
  }),
});

function guardInvalid(message, details = {}) {
  throw consultError(CONSULTATION_GUARD_INVALID, message, 400, details);
}

// String-form params arrive as strings; coerce numeric-looking strings to
// numbers so `min=1` validates against the integer validator.
function coerceGuardParam(value) {
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return value;
}

// Split a guard's raw param list on commas that are not inside quotes.
function splitGuardParams(raw) {
  const parts = [];
  let current = '';
  let quote = '';
  for (const ch of raw) {
    if ((ch === '"' || ch === "'") && (quote === '' || quote === ch)) {
      quote = quote === '' ? ch : '';
      current += ch;
    } else if (ch === ',' && quote === '') {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function unquoteGuardValue(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed[0] === '"' && trimmed.endsWith('"')) || (trimmed[0] === "'" && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// Parse the canonical string form: `type(param=value,param=value)`.
function parseGuardString(text) {
  const trimmed = String(text).trim();
  const match = /^([a-z][a-z0-9_]*)\s*(?:\((.*)\))?$/.exec(trimmed);
  if (!match) guardInvalid(`malformed typed guard '${text}'`, { input: text });
  const [, type, rawParams] = match;
  const params = {};
  if (rawParams && rawParams.trim() !== '') {
    for (const chunk of splitGuardParams(rawParams)) {
      const eq = chunk.indexOf('=');
      if (eq === -1) {
        guardInvalid(`guard '${type}' param '${chunk.trim()}' must be name=value`, { guardType: type, input: text });
      }
      params[chunk.slice(0, eq).trim()] = unquoteGuardValue(chunk.slice(eq + 1));
    }
  }
  return { type, params };
}

function buildCanonicalGuard(type, supplied) {
  const spec = TYPED_GUARD_SPECS[type];
  if (!spec) guardInvalid(`unknown typed guard '${type}'`, { guardType: type });
  for (const name of Object.keys(supplied)) {
    if (name !== 'type' && !(name in spec.params)) {
      guardInvalid(`guard '${type}' has unknown param '${name}'`, { guardType: type, param: name });
    }
  }
  const canonical = { type };
  for (const [name, paramSpec] of Object.entries(spec.params)) {
    const value = coerceGuardParam(supplied[name] === undefined ? paramSpec.default : supplied[name]);
    if (!paramSpec.validate(value)) {
      guardInvalid(`guard '${type}' param '${name}' has invalid value ${JSON.stringify(supplied[name])}`, {
        guardType: type, param: name, value: supplied[name],
      });
    }
    canonical[name] = value;
  }
  return canonical;
}

/**
 * Validate a single typed guard (canonical string or structured object) and
 * return its canonical object. Rejects unknown guard types, unknown params and
 * illegal param values with CONSULTATION_GUARD_INVALID(400). Exported for the
 * P5 compiler gate to reuse.
 */
export function validateTypedGuard(guard) {
  if (typeof guard === 'string') {
    const { type, params } = parseGuardString(guard);
    return buildCanonicalGuard(type, params);
  }
  if (guard && typeof guard === 'object') {
    if (typeof guard.type !== 'string' || guard.type.trim() === '') {
      guardInvalid('typed guard object requires a non-empty `type`', { input: guard });
    }
    return buildCanonicalGuard(guard.type.trim(), guard);
  }
  guardInvalid(`typed guard must be a canonical string or an object, got ${typeof guard}`, { input: guard });
}

/**
 * Normalize a requiredGuards input (single string/object or array) into an
 * array of canonical typed guards. Undefined/null/empty string → []. Any
 * invalid entry raises CONSULTATION_GUARD_INVALID(400). Exported for the P5
 * compiler gate to reuse.
 */
export function parseTypedGuards(input) {
  if (input === undefined || input === null) return [];
  if (typeof input === 'string' && input.trim() === '') return [];
  const items = Array.isArray(input) ? input : [input];
  return items.map((item) => validateTypedGuard(item));
}

// ── C6: DecisionRecord CRUD ──────────────────────────────────────────────────

function rowDecision(row) {
  return {
    id: row.id,
    roundId: row.round_id,
    decision: row.decision,
    rationale: row.rationale ?? '',
    requiredGuards: parseJson(row.required_guards_json, []),
    decidedBySessionId: row.decided_by_session_id || '',
    decidedByNodeId: row.decided_by_node_id || '',
    baseRevision: row.base_revision == null ? null : Number(row.base_revision),
    contextDigest: row.context_digest || '',
    expiresAt: row.expires_at || '',
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
  };
}

/**
 * Create a DecisionRecord (C6). The round must exist (404 otherwise). Strategic
 * decisions (no decidedByNodeId) must carry decidedBySessionId; tactical
 * decisions (baseRevision set) must carry contextDigest or an explicit
 * invalidation condition (expiresAt). requiredGuards are validated one-by-one
 * as typed guards (CONSULTATION_GUARD_INVALID on any invalid entry). This does
 * NOT couple to the round state — P4-T3's decide control flow creates the
 * decision and then transitions the round to DECIDED.
 */
export async function createConsultationDecision({
  roundId,
  decision,
  rationale,
  requiredGuards,
  decidedBySessionId,
  decidedByNodeId,
  baseRevision,
  contextDigest,
  expiresAt,
}) {
  const decisionId = id('dec');
  const timestamp = nowIso();
  return withDatabase((db) => {
    const round = db.prepare('SELECT id FROM consultation_rounds WHERE id = ?').get(roundId);
    if (!round) {
      throw consultError(CONSULTATION_NOT_FOUND, `consultation round ${roundId} not found`, 404, { roundId });
    }
    if (typeof decision !== 'string' || decision.trim() === '') {
      throw consultError(CONSULTATION_DECISION_INVALID, 'decision must be a non-empty string', 400, { decision });
    }
    const node = typeof decidedByNodeId === 'string' && decidedByNodeId.trim() ? decidedByNodeId.trim() : '';
    const session = typeof decidedBySessionId === 'string' && decidedBySessionId.trim() ? decidedBySessionId.trim() : '';
    if (!node && !session) {
      throw consultError(
        CONSULTATION_DECISION_INVALID,
        'strategic decision (no decidedByNodeId) requires decidedBySessionId',
        400,
        { decidedBySessionId, decidedByNodeId },
      );
    }
    const revision = baseRevision == null ? null : Number(baseRevision);
    if (baseRevision != null && (!Number.isInteger(revision) || revision < 0)) {
      throw consultError(CONSULTATION_DECISION_INVALID, 'baseRevision must be a non-negative integer', 400, { baseRevision });
    }
    const digest = typeof contextDigest === 'string' && contextDigest.trim() ? contextDigest.trim() : '';
    let expiry = '';
    if (typeof expiresAt === 'string' && expiresAt.trim() !== '') {
      if (!isValidIso(expiresAt)) {
        throw consultError(CONSULTATION_DECISION_INVALID, 'expiresAt must be a valid ISO-8601 timestamp when provided', 400, { expiresAt });
      }
      expiry = new Date(expiresAt).toISOString();
    }
    if (revision != null && !digest && !expiry) {
      throw consultError(
        CONSULTATION_DECISION_INVALID,
        'tactical decision (baseRevision) requires contextDigest or an explicit invalidation condition (expiresAt)',
        400,
        { baseRevision, contextDigest, expiresAt },
      );
    }
    const guards = parseTypedGuards(requiredGuards);

    db.prepare(`
      INSERT INTO consultation_decision_records
        (id, round_id, decision, rationale, required_guards_json, decided_by_session_id,
         decided_by_node_id, base_revision, context_digest, expires_at, schema_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      decisionId, roundId, decision.trim(),
      typeof rationale === 'string' ? rationale : '',
      json(guards, []),
      session, node || null, revision, digest || null, expiry || null,
      timestamp,
    );
    return rowDecision(db.prepare('SELECT * FROM consultation_decision_records WHERE id = ?').get(decisionId));
  }, { mutate: true });
}

export async function getConsultationDecision(decisionId) {
  return withDatabase((db) => {
    const row = db.prepare('SELECT * FROM consultation_decision_records WHERE id = ?').get(decisionId);
    if (!row) {
      throw consultError(CONSULTATION_NOT_FOUND, `consultation decision ${decisionId} not found`, 404, { decisionId });
    }
    return rowDecision(row);
  });
}

export async function listConsultationDecisions(roundId) {
  return withDatabase((db) => db.prepare(
    'SELECT * FROM consultation_decision_records WHERE round_id = ? ORDER BY created_at, id',
  ).all(roundId).map(rowDecision));
}

// The expert "vote" is the model-generated structured recommendation inside the
// packet's system-bound consultation block. Two experts agree when their
// recommendation digests are identical; the full packet digest also bakes in
// per-attempt provenance (runId/taskId/attemptId/sessionId) which always
// differs between experts, so the vote digest is scoped to the recommendation.
function voteDigestOf(packet) {
  const recommendation = packet && packet.consultation && packet.consultation.recommendation;
  if (!recommendation) return null;
  return `sha256:${createHash('sha256').update(stableJson(recommendation), 'utf8').digest('hex')}`;
}

function rowExpert(ex) {
  return {
    id: ex.id,
    expertSessionId: ex.expert_session_id || '',
    attemptId: ex.attempt_id || '',
    role: ex.role,
    writablePaths: parseJson(ex.writable_paths_json, []),
    status: ex.status,
  };
}

// Assemble a round from its row, deriving packetIds from the append-only
// consultation_packet_links relation (never from a mutable array column).
function rowRound(db, row) {
  if (!row) return null;
  const experts = db.prepare(
    'SELECT * FROM consultation_expert_assignments WHERE round_id = ? ORDER BY created_at, id',
  ).all(row.id).map(rowExpert);
  const packetLinks = db.prepare(
    'SELECT packet_id FROM consultation_packet_links WHERE round_id = ? ORDER BY created_at, packet_id',
  ).all(row.id);
  return {
    id: row.id,
    rootSessionId: row.root_session_id,
    roundNumber: row.round_number,
    state: row.state,
    objective: row.objective,
    question: row.question,
    quorum: row.quorum,
    budget: parseJson(row.budget_json, {}),
    deadline: row.deadline,
    decidedDecisionRecordId: row.decided_decision_record_id || '',
    failureKind: row.failure_kind || '',
    failureReason: row.failure_reason || '',
    schemaVersion: row.schema_version,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    experts,
    packetIds: packetLinks.map((link) => link.packet_id),
  };
}

// Internal CAS transition. `allowed` is an explicit override used only by
// recoverConsultationRound for the gated FAILED → DISPATCHED edge; the default
// path enforces the frozen CONSULTATION_LEGAL_TRANSITIONS set. A stale
// version (WHERE version = ?) or an illegal move both raise a 409.
function transitionRound(db, round, toState, { now, allowed = null } = {}) {
  const timestamp = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : nowIso();
  const legal = allowed || CONSULTATION_LEGAL_TRANSITIONS[round.state] || [];
  if (!legal.includes(toState)) {
    throw consultError(
      CONSULTATION_ROUND_STATE_INVALID,
      `illegal consultation round transition ${round.state} → ${toState}`,
      409,
      { roundId: round.id, fromState: round.state, toState },
    );
  }
  const changed = db.prepare(
    'UPDATE consultation_rounds SET state = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
  ).run(toState, timestamp, round.id, round.version).changes;
  if (changed !== 1) {
    throw consultError(
      CONSULTATION_ROUND_STATE_CONFLICT,
      `consultation round ${round.id} changed concurrently (CAS version ${round.version})`,
      409,
      { roundId: round.id, expectedVersion: round.version },
    );
  }
  return round.version + 1;
}

// Load a round and assert the caller's optimistic version, if any, still holds.
function loadRound(db, roundId, version) {
  const round = db.prepare('SELECT * FROM consultation_rounds WHERE id = ?').get(roundId);
  if (!round) {
    throw consultError(CONSULTATION_NOT_FOUND, `consultation round ${roundId} not found`, 404, { roundId });
  }
  if (version != null && Number(version) !== Number(round.version)) {
    throw consultError(
      CONSULTATION_ROUND_STATE_CONFLICT,
      `consultation round ${roundId} version mismatch: caller ${version}, stored ${round.version}`,
      409,
      { roundId, expectedVersion: version, storedVersion: round.version },
    );
  }
  return round;
}

/**
 * Create a consultation round in PLANNED state. Experts are read-only
 * (writablePaths is forced to the empty list); every assignment starts as
 * `assigned` with expertSessionId/attemptId to be bound at dispatch time.
 */
export async function createConsultationRound({
  rootSessionId,
  roundNumber,
  objective,
  question,
  experts,
  quorum,
  budget,
  deadline,
}) {
  if (!rootSessionId || typeof rootSessionId !== 'string') {
    throw consultError(CONSULTATION_EXPERT_ASSIGNMENT_INVALID, 'rootSessionId is required', 400);
  }
  if (!Number.isInteger(quorum) || quorum < 1) {
    throw consultError(CONSULTATION_EXPERT_ASSIGNMENT_INVALID, `quorum must be an integer >= 1, got ${quorum}`, 400);
  }
  if (!Array.isArray(experts) || experts.length === 0) {
    throw consultError(CONSULTATION_EXPERT_ASSIGNMENT_INVALID, 'consultation round requires at least one expert', 400);
  }
  for (const expert of experts) {
    if (!expert || typeof expert !== 'object' || typeof expert.role !== 'string' || expert.role.trim() === '') {
      throw consultError(CONSULTATION_EXPERT_ASSIGNMENT_INVALID, 'each expert requires a non-empty role', 400);
    }
    const writable = Array.isArray(expert.writablePaths) ? expert.writablePaths : [];
    if (writable.length > 0) {
      throw consultError(
        CONSULTATION_EXPERT_ASSIGNMENT_INVALID,
        `consultation expert '${expert.role}' must be read-only (writablePaths must be empty)`,
        400,
        { role: expert.role, writablePaths: writable },
      );
    }
  }
  if (!isValidIso(deadline)) {
    throw consultError(CONSULTATION_EXPERT_ASSIGNMENT_INVALID, 'deadline must be a valid ISO-8601 timestamp', 400, { deadline });
  }

  const roundId = id('round');
  const timestamp = nowIso();
  const budgetJson = json(budget ?? {}, {});

  return withDatabase((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT INTO consultation_rounds
          (id, root_session_id, round_number, state, objective, question, quorum,
           budget_json, deadline, created_at, updated_at)
        VALUES (?, ?, ?, 'PLANNED', ?, ?, ?, ?, ?, ?, ?)
      `).run(roundId, rootSessionId, roundNumber, objective, question, quorum,
        budgetJson, deadline, timestamp, timestamp);
    } catch (error) {
      db.exec('ROLLBACK');
      if (String(error?.message || '').includes('UNIQUE')) {
        throw consultError(
          CONSULTATION_ROUND_STATE_CONFLICT,
          `consultation round already exists for root_session ${rootSessionId} round ${roundNumber}`,
          409,
          { rootSessionId, roundNumber },
        );
      }
      throw error;
    }
    const insertExpert = db.prepare(`
      INSERT INTO consultation_expert_assignments
        (id, round_id, role, writable_paths_json, status, created_at)
      VALUES (?, ?, ?, '[]', 'assigned', ?)
    `);
    for (const expert of experts) {
      insertExpert.run(id('expert'), roundId, expert.role.trim(), timestamp);
    }
    db.exec('COMMIT');
    return rowRound(db, db.prepare('SELECT * FROM consultation_rounds WHERE id = ?').get(roundId));
  }, { mutate: true });
}

export async function getConsultationRound(roundId) {
  return withDatabase((db) => {
    const row = db.prepare('SELECT * FROM consultation_rounds WHERE id = ?').get(roundId);
    if (!row) {
      throw consultError(CONSULTATION_NOT_FOUND, `consultation round ${roundId} not found`, 404, { roundId });
    }
    return rowRound(db, row);
  });
}

export async function listConsultationRounds({ rootSessionId, limit = 50 } = {}) {
  const maxLimit = Math.min(Math.max(Number.isInteger(limit) ? limit : 50, 1), 500);
  return withDatabase((db) => {
    const rows = rootSessionId
      ? db.prepare('SELECT * FROM consultation_rounds WHERE root_session_id = ? ORDER BY created_at DESC LIMIT ?').all(rootSessionId, maxLimit)
      : db.prepare('SELECT * FROM consultation_rounds ORDER BY created_at DESC LIMIT ?').all(maxLimit);
    return rows.map((row) => rowRound(db, row));
  });
}

// Resolve which expert assignment a dispatch call targets. Prefer an explicit
// expertAssignmentId; otherwise match a previously-bound expert_session_id, then
// fall back to the next unbound `assigned` expert (creation order).
function resolveExpertForDispatch(db, roundId, { expertAssignmentId, expertSessionId }) {
  if (expertAssignmentId) {
    const ex = db.prepare('SELECT * FROM consultation_expert_assignments WHERE id = ? AND round_id = ?').get(expertAssignmentId, roundId);
    if (ex) return ex;
  }
  if (expertSessionId) {
    const bound = db.prepare(
      'SELECT * FROM consultation_expert_assignments WHERE round_id = ? AND expert_session_id = ? LIMIT 1',
    ).get(roundId, expertSessionId);
    if (bound) return bound;
    const next = db.prepare(
      "SELECT * FROM consultation_expert_assignments WHERE round_id = ? AND status = 'assigned' AND expert_session_id IS NULL ORDER BY created_at, id LIMIT 1",
    ).get(roundId);
    if (next) return next;
    return null;
  }
  return null;
}

/**
 * Dispatch an expert attempt. The first dispatch moves PLANNED → DISPATCHED;
 * later dispatches only bind more experts (round stays DISPATCHED). Binding is
 * idempotent: re-dispatching the same expert refreshes session/attempt ids.
 */
export async function dispatchConsultationRound(roundId, { expertAssignmentId, expertSessionId, attemptId, version } = {}) {
  return withDatabase((db) => {
    const round = loadRound(db, roundId, version);
    if (round.state !== 'PLANNED' && round.state !== 'DISPATCHED') {
      throw consultError(
        CONSULTATION_ROUND_STATE_INVALID,
        `cannot dispatch consultation round ${roundId} from state ${round.state}`,
        409,
        { roundId, state: round.state },
      );
    }
    const expert = resolveExpertForDispatch(db, roundId, { expertAssignmentId, expertSessionId });
    if (!expert) {
      throw consultError(
        CONSULTATION_EXPERT_ASSIGNMENT_INVALID,
        `no dispatcheable expert for round ${roundId}`,
        400,
        { roundId },
      );
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        UPDATE consultation_expert_assignments
        SET expert_session_id = ?, attempt_id = ?, status = 'dispatched'
        WHERE id = ?
      `).run(expertSessionId || null, attemptId || null, expert.id);
      if (round.state === 'PLANNED') {
        transitionRound(db, round, 'DISPATCHED', {});
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowRound(db, db.prepare('SELECT * FROM consultation_rounds WHERE id = ?').get(roundId));
  }, { mutate: true });
}

/**
 * Append-only packet association. The same (round_id, attempt_id, packet_id)
 * link is idempotent; packetIds on the round are always derived from this
 * relation, never from a mutable array column.
 */
export async function linkPacketToRound(roundId, attemptId, packetId) {
  if (!attemptId || !packetId) {
    throw consultError(CONSULTATION_PACKET_INVALID, 'attemptId and packetId are required to link a packet', 400);
  }
  return withDatabase((db) => {
    const round = db.prepare('SELECT id FROM consultation_rounds WHERE id = ?').get(roundId);
    if (!round) {
      throw consultError(CONSULTATION_NOT_FOUND, `consultation round ${roundId} not found`, 404, { roundId });
    }
    const info = db.prepare(`
      INSERT OR IGNORE INTO consultation_packet_links (round_id, attempt_id, packet_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(roundId, attemptId, packetId, nowIso());
    return info.changes > 0;
  }, { mutate: true });
}

function allExpertsDone(db, roundId) {
  const experts = db.prepare(
    "SELECT id, attempt_id FROM consultation_expert_assignments WHERE round_id = ? AND status = 'dispatched'",
  ).all(roundId);
  if (experts.length === 0) return false;
  return experts.every((ex) => {
    if (!ex.attempt_id) return false;
    const link = db.prepare(
      'SELECT 1 FROM consultation_packet_links WHERE round_id = ? AND attempt_id = ? LIMIT 1',
    ).get(roundId, ex.attempt_id);
    return Boolean(link);
  });
}

/** True when every dispatched expert has produced at least one packet. */
export async function areAllConsultationExpertsDone(roundId) {
  return withDatabase((db) => allExpertsDone(db, roundId));
}

/** DISPATCHED → AGGREGATING. Optionally verifies every dispatched expert produced a packet first. */
export async function beginAggregation(roundId, { version, verifyAllExpertsDone = false } = {}) {
  return withDatabase((db) => {
    const round = loadRound(db, roundId, version);
    if (round.state !== 'DISPATCHED') {
      throw consultError(
        CONSULTATION_ROUND_STATE_INVALID,
        `cannot begin aggregation for round ${roundId} from state ${round.state}`,
        409,
        { roundId, state: round.state },
      );
    }
    if (verifyAllExpertsDone && !allExpertsDone(db, roundId)) {
      throw consultError(
        CONSULTATION_QUORUM_NOT_MET,
        `cannot begin aggregation for round ${roundId}: not all dispatched experts have produced packets`,
        409,
        { roundId },
      );
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      transitionRound(db, round, 'AGGREGATING', {});
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowRound(db, db.prepare('SELECT * FROM consultation_rounds WHERE id = ?').get(roundId));
  }, { mutate: true });
}

// Quorum + vote-digest gate shared by decideConsultationRound and the read-only
// HTTP pre-check (assertConsultationRoundDecidable). Verifies — when
// requireAggregating (the decide path) — that the round is AGGREGATING, that ≥
// quorum distinct experts have packets, and that every expert vote digest
// agrees. Returns the intermediate aggregation data (round, quorum, distinct
// expert → packet map, vote digests) so the decide path can complete the DECIDED
// transition without re-deriving it. Any failure throws
// CONSULTATION_ROUND_STATE_INVALID or CONSULTATION_QUORUM_NOT_MET and performs
// no writes. requireAggregating:false is used by the read-only pre-check, which
// gates the aggregation outcome (quorum/digest) while leaving the AGGREGATING
// state gate to decideConsultationRound — so terminal-state rounds still reach
// decision-record validation (guards) rather than short-circuiting on state.
async function assertRoundDecidable(db, round, { requireAggregating = true } = {}) {
  if (requireAggregating && round.state !== 'AGGREGATING') {
    throw consultError(
      CONSULTATION_ROUND_STATE_INVALID,
      `cannot decide round ${round.id} from state ${round.state}`,
      409,
      { roundId: round.id, state: round.state },
    );
  }
  const quorum = Number(round.quorum);
  const links = db.prepare('SELECT attempt_id, packet_id FROM consultation_packet_links WHERE round_id = ?').all(round.id);
  const expertByAttempt = new Map(db.prepare(
    'SELECT attempt_id, id FROM consultation_expert_assignments WHERE round_id = ? AND attempt_id IS NOT NULL',
  ).all(round.id).map((ex) => [ex.attempt_id, ex.id]));
  const expertPacket = new Map();
  for (const link of links) {
    const expertId = expertByAttempt.get(link.attempt_id);
    if (!expertId) continue;
    if (!expertPacket.has(expertId)) expertPacket.set(expertId, link.packet_id);
  }
  if (expertPacket.size < quorum) {
    throw consultError(
      CONSULTATION_QUORUM_NOT_MET,
      `round ${round.id} quorum ${quorum} not met: only ${expertPacket.size} distinct experts have packets`,
      409,
      { roundId: round.id, quorum, distinctExperts: expertPacket.size },
    );
  }
  const voteDigests = new Set();
  for (const packetId of expertPacket.values()) {
    const packet = await getResultPacket(packetId);
    const vote = voteDigestOf(packet);
    if (!vote) {
      throw consultError(
        CONSULTATION_QUORUM_NOT_MET,
        `round ${round.id}: packet ${packetId} has no consultation recommendation digest`,
        409,
        { roundId: round.id, packetId },
      );
    }
    voteDigests.add(vote);
  }
  if (voteDigests.size !== 1) {
    throw consultError(
      CONSULTATION_QUORUM_NOT_MET,
      `round ${round.id} expert recommendations disagree (${voteDigests.size} distinct digests)`,
      409,
      { roundId: round.id, distinctVoteDigests: voteDigests.size },
    );
  }
  return { round, quorum, expertPacket, voteDigests };
}

/**
 * AGGREGATING → DECIDED once ≥ quorum distinct experts have packets whose
 * recommendation digests (the expert vote) all agree. Quorum or digest failure
 * raises CONSULTATION_QUORUM_NOT_MET and leaves the round in AGGREGATING so the
 * caller can transition it to INCONCLUSIVE. The quorum + digest gate is shared
 * with assertConsultationRoundDecidable via assertRoundDecidable.
 */
export async function decideConsultationRound(roundId, { version, decisionRecordId } = {}) {
  return withDatabase(async (db) => {
    const round = loadRound(db, roundId, version);
    const decidable = await assertRoundDecidable(db, round);
    db.exec('BEGIN IMMEDIATE');
    try {
      transitionRound(db, decidable.round, 'DECIDED', {});
      if (decisionRecordId) {
        db.prepare('UPDATE consultation_rounds SET decided_decision_record_id = ?, updated_at = ? WHERE id = ?')
          .run(decisionRecordId, nowIso(), roundId);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowRound(db, db.prepare('SELECT * FROM consultation_rounds WHERE id = ?').get(roundId));
  }, { mutate: true });
}

/**
 * Read-only decidability pre-check for the decide control flow (P4 fix): confirms
 * a round is decidable — ≥ quorum distinct experts with packets and unanimous
 * vote digests — BEFORE a DecisionRecord is persisted, so a round that can never
 * reach DECIDED (it will conclude INCONCLUSIVE/FAILED/EXPIRED) does not leak a
 * decision record (C6: a DecisionRecord is a decided outcome). Loads the round
 * via the read-only withDatabase path with the optional version CAS check
 * (loadRound), calls the shared assertRoundDecidable gate, and NEVER migrates
 * state or writes. Quorum/digest failure throws CONSULTATION_QUORUM_NOT_MET(409);
 * a missing/stale round throws CONSULTATION_NOT_FOUND(404) /
 * CONSULTATION_ROUND_STATE_CONFLICT(409).
 */
export async function assertConsultationRoundDecidable(roundId, { version } = {}) {
  return withDatabase((db) => assertRoundDecidable(db, loadRound(db, roundId, version), { requireAggregating: false }));
}

/** DISPATCHED|AGGREGATING → FAILED. Persists failureKind so recovery can gate on the retry whitelist. */
export async function failConsultationRound(roundId, { failureKind, reason, version } = {}) {
  return withDatabase((db) => {
    const round = loadRound(db, roundId, version);
    if (round.state !== 'DISPATCHED' && round.state !== 'AGGREGATING') {
      throw consultError(
        CONSULTATION_ROUND_STATE_INVALID,
        `cannot fail round ${roundId} from state ${round.state}`,
        409,
        { roundId, state: round.state },
      );
    }
    const kind = typeof failureKind === 'string' && failureKind.trim() ? failureKind.trim() : 'unknown_outcome';
    db.exec('BEGIN IMMEDIATE');
    try {
      transitionRound(db, round, 'FAILED', {});
      db.prepare('UPDATE consultation_rounds SET failure_kind = ?, failure_reason = ? WHERE id = ?')
        .run(kind, typeof reason === 'string' ? reason : '', roundId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowRound(db, db.prepare('SELECT * FROM consultation_rounds WHERE id = ?').get(roundId));
  }, { mutate: true });
}

/**
 * FAILED → DISPATCHED for a retryable failure. Only allowed when the persisted
 * failureKind is in RETRYABLE_CONSULTATION_FAILURE_KINDS; otherwise the round is
 * a hard failure and recover raises CONSULTATION_ROUND_STATE_INVALID. Expert
 * assignments are reset to `assigned` (re-dispatch).
 */
export async function recoverConsultationRound(roundId, { version } = {}) {
  return withDatabase((db) => {
    const round = loadRound(db, roundId, version);
    if (round.state !== 'FAILED') {
      throw consultError(
        CONSULTATION_ROUND_STATE_INVALID,
        `cannot recover round ${roundId} from state ${round.state}`,
        409,
        { roundId, state: round.state },
      );
    }
    if (!RETRYABLE_CONSULTATION_FAILURE_KINDS.includes(round.failure_kind)) {
      throw consultError(
        CONSULTATION_ROUND_STATE_INVALID,
        `round ${roundId} failure '${round.failure_kind || ''}' is not retryable`,
        409,
        { roundId, failureKind: round.failure_kind || '' },
      );
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      transitionRound(db, round, 'DISPATCHED', { allowed: ['DISPATCHED'] });
      db.prepare('UPDATE consultation_rounds SET failure_kind = NULL, failure_reason = NULL WHERE id = ?').run(roundId);
      db.prepare(`
        UPDATE consultation_expert_assignments
        SET status = 'assigned', expert_session_id = NULL, attempt_id = NULL
        WHERE round_id = ?
      `).run(roundId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowRound(db, db.prepare('SELECT * FROM consultation_rounds WHERE id = ?').get(roundId));
  }, { mutate: true });
}

/** True when the round is past its deadline AND in a deadline-eligible state. */
export function isConsultationRoundPastDeadline(round, { now = new Date() } = {}) {
  if (!round || !['DISPATCHED', 'AGGREGATING'].includes(round.state)) return false;
  const check = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  return isValidIso(round.deadline) && check.getTime() > new Date(round.deadline).getTime();
}

/**
 * Expire a single round when now > deadline and the round is DISPATCHED or
 * AGGREGATING. No-op (returns false) when not applicable — reconciler-friendly.
 */
export async function expireConsultationRoundIfPastDeadline(roundId, { now } = {}) {
  return withDatabase((db) => {
    const round = db.prepare('SELECT * FROM consultation_rounds WHERE id = ?').get(roundId);
    if (!round) {
      throw consultError(CONSULTATION_NOT_FOUND, `consultation round ${roundId} not found`, 404, { roundId });
    }
    if (!isConsultationRoundPastDeadline(round, { now })) return false;
    db.exec('BEGIN IMMEDIATE');
    try {
      transitionRound(db, round, 'EXPIRED', { now });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return true;
  }, { mutate: true });
}

/** List rounds past their deadline that are still DISPATCHED/AGGREGATING (P6 reconciler hook). */
export async function consultationRoundsPastDeadline({ now = new Date(), limit = 100 } = {}) {
  const check = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const maxLimit = Math.min(Math.max(Number.isInteger(limit) ? limit : 100, 1), 500);
  return withDatabase((db) => db.prepare(
    `SELECT id FROM consultation_rounds
     WHERE state IN ('DISPATCHED', 'AGGREGATING') AND deadline IS NOT NULL AND deadline < ?
     ORDER BY deadline, id LIMIT ?`,
  ).all(check.toISOString(), maxLimit).map((row) => row.id));
}

/** Batch expiry over every eligible past-deadline round (P6 reconciler mount). */
export async function expireConsultationRoundsPastDeadline({ now = new Date(), limit = 100 } = {}) {
  const ids = await consultationRoundsPastDeadline({ now, limit });
  const expired = [];
  for (const roundId of ids) {
    try {
      if (await expireConsultationRoundIfPastDeadline(roundId, { now })) expired.push(roundId);
    } catch {
      // A CAS conflict means another process already moved the round; skip.
    }
  }
  return expired;
}

/**
 * List PLANNED rounds that were created before `now - olderThanMs` and have
 * never been dispatched (P6-T3 reconciler hook). These are startup "orphan"
 * candidates: a strategic consultation stuck in PLANNED past the threshold is
 * cancelled at startup so stale rounds do not linger forever. Ordered by
 * creation time then id so a bounded sweep is deterministic.
 */
export async function consultationOrphanedPlannedRounds({ olderThanMs = 24 * 60 * 60 * 1000, now = new Date(), limit = 100 } = {}) {
  const check = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const cutoff = new Date(check.getTime() - olderThanMs);
  const maxLimit = Math.min(Math.max(Number.isInteger(limit) ? limit : 100, 1), 500);
  return withDatabase((db) => db.prepare(
    `SELECT id FROM consultation_rounds
     WHERE state = 'PLANNED' AND created_at < ?
     ORDER BY created_at, id LIMIT ?`,
  ).all(cutoff.toISOString(), maxLimit).map((row) => row.id));
}

/** PLANNED|DISPATCHED|AGGREGATING → CANCELLED. */
export async function cancelConsultationRound(roundId, { version, reason } = {}) {
  return withDatabase((db) => {
    const round = loadRound(db, roundId, version);
    if (round.state !== 'PLANNED' && round.state !== 'DISPATCHED' && round.state !== 'AGGREGATING') {
      throw consultError(
        CONSULTATION_ROUND_STATE_INVALID,
        `cannot cancel round ${roundId} from state ${round.state}`,
        409,
        { roundId, state: round.state },
      );
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      transitionRound(db, round, 'CANCELLED', {});
      if (reason) {
        db.prepare('UPDATE consultation_rounds SET failure_reason = ?, updated_at = ? WHERE id = ?')
          .run(typeof reason === 'string' ? reason : '', nowIso(), roundId);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowRound(db, db.prepare('SELECT * FROM consultation_rounds WHERE id = ?').get(roundId));
  }, { mutate: true });
}

/**
 * Generic state-migration API over the frozen legal transition set (C5). Enforces
 * CONSULTATION_ROUND_STATE_INVALID for illegal moves and
 * CONSULTATION_ROUND_STATE_CONFLICT for stale versions. Used directly by P4/P6
 * callers (e.g. concluding a round INCONCLUSIVE after a failed quorum attempt).
 */
export async function transitionRoundState(roundId, toState, { version, now } = {}) {
  return withDatabase((db) => {
    const round = loadRound(db, roundId, version);
    db.exec('BEGIN IMMEDIATE');
    try {
      transitionRound(db, round, toState, { now });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rowRound(db, db.prepare('SELECT * FROM consultation_rounds WHERE id = ?').get(roundId));
  }, { mutate: true });
}

// ── P6-T1: tactical decision evaluation (baseRevision + contextDigest / expiry) ─

/**
 * Evaluate a tactical consultation decision against the current running facts.
 * A decision is "tactical" when it was decided against a specific base revision
 * (baseRevision set); strategic decisions (no baseRevision) are always
 * `{ tactical: false, valid: true }` and are never invalidated here.
 *
 * A tactical decision is invalid when any of the following hold (checked in
 * this order):
 *   - the caller's baseRevision is provided and differs from the decision's
 *     baseRevision          → { valid: false, reason: 'base_revision_changed' }
 *   - the caller's contextDigest is provided and differs from the decision's
 *     contextDigest         → { valid: false, reason: 'context_digest_changed' }
 *     (a revision not changing does NOT mean the running facts did not change)
 *   - the decision carries expiresAt and now > expiresAt
 *                           → { valid: false, reason: 'expired' }
 * If none match → { tactical: true, valid: true }.
 *
 * A missing decision id raises CONSULTATION_NOT_FOUND(404). `now` may be a Date
 * or an ISO-8601 string; it defaults to the current time.
 */
export async function evaluateTacticalConsultationDecision(decisionId, { baseRevision, contextDigest, now } = {}) {
  const decision = await getConsultationDecision(decisionId);
  if (decision.baseRevision == null) {
    return { tactical: false, valid: true };
  }
  if (baseRevision != null && Number(baseRevision) !== Number(decision.baseRevision)) {
    return { tactical: true, valid: false, reason: 'base_revision_changed' };
  }
  if (contextDigest != null && contextDigest !== decision.contextDigest) {
    return { tactical: true, valid: false, reason: 'context_digest_changed' };
  }
  if (decision.expiresAt) {
    let check;
    if (now instanceof Date && !Number.isNaN(now.getTime())) {
      check = now;
    } else if (typeof now === 'string' && isValidIso(now)) {
      check = new Date(now);
    } else {
      check = new Date();
    }
    if (check.getTime() > new Date(decision.expiresAt).getTime()) {
      return { tactical: true, valid: false, reason: 'expired' };
    }
  }
  return { tactical: true, valid: true };
}

// ── P6-T2: follow-up consultation round (roundNumber > 1, appended question) ──

/**
 * Create a follow-up consultation round (roundNumber > 1) under the same root
 * session, appending a new question. The new round's number is the base round's
 * number + 1; experts/quorum/budget/deadline are inherited from the base round
 * when not supplied explicitly. question/objective are required (the new
 * inquiry).
 *
 * Persistence reuses createConsultationRound, so the
 * UNIQUE(root_session_id, round_number) constraint rejects a duplicate follow-up
 * with CONSULTATION_ROUND_STATE_CONFLICT. A missing base round raises
 * CONSULTATION_NOT_FOUND(404). Round 1 and the new round coexist under the same
 * root session.
 */
export async function createFollowUpConsultationRound({
  rootSessionId,
  baseRoundId,
  question,
  objective,
  experts,
  quorum,
  budget,
  deadline,
}) {
  const baseRound = await getConsultationRound(baseRoundId);
  const session = typeof rootSessionId === 'string' && rootSessionId.trim()
    ? rootSessionId.trim()
    : baseRound.rootSessionId;
  if (typeof question !== 'string' || question.trim() === '') {
    throw consultError(
      CONSULTATION_EXPERT_ASSIGNMENT_INVALID,
      'follow-up consultation requires a question (the new inquiry)',
      400,
      { question },
    );
  }
  if (typeof objective !== 'string' || objective.trim() === '') {
    throw consultError(
      CONSULTATION_EXPERT_ASSIGNMENT_INVALID,
      'follow-up consultation requires an objective',
      400,
      { objective },
    );
  }
  return createConsultationRound({
    rootSessionId: session,
    roundNumber: baseRound.roundNumber + 1,
    objective: objective.trim(),
    question: question.trim(),
    experts: experts ?? baseRound.experts,
    quorum: quorum ?? baseRound.quorum,
    budget: budget ?? baseRound.budget,
    deadline: deadline ?? baseRound.deadline,
  });
}

export { nowIso, id };
