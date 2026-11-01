// Per-session goal state for goal mode. Two logical layers live in one object:
//   - intent (user-owned, written via PATCH /api/sessions/:id { goal }):
//       objective, tokenBudget, enabled, chasing
//   - snapshot (provider-mirrored, written at turn finalize; never overwrites
//     the objective): status, tokensUsed, timeUsedSeconds, updatedAt
//       codex app-server: mirrored from thread/goal/updated notifications
//       prompt-only runtimes (Claude Code and AgY): synthesized at chase-check
//       (no provider goal channel; see synthesizeClaudeGoalSnapshot)
//   - chase accounting (backend-owned, written by the goal-continuation logic
//     and the goal/control resume|pause route; preserved across snapshot applies
//     and intent edits except an intent edit resets the counters):
//       continuationCount, continuationLastAt, continuationLastTokensUsed,
//       continuationNoProgress
//
// A goal is meaningful only when it has an objective; without one the field is
// dropped from session meta entirely. Mirrors the shape/style of
// session-task-card.mjs.

const MAX_GOAL_OBJECTIVE_CHARS = 480;

// Goal chasing (cross-turn auto-continuation) guardrails. See shouldContinueGoal.
const MAX_GOAL_CONTINUATIONS = 10;
const MIN_CONTINUATION_GAP_MS = 5000; // rate cap: >=5s between fired continuations
const GOAL_NO_PROGRESS_LIMIT = 2; // hard stop after N consecutive no-progress turns
const GOAL_CONTINUE_INTERNAL_OPERATION = 'goal_continue';
const AGY_RUNTIME_FAMILIES = Object.freeze(new Set([
  'agy-json',
  'agy-stream-json',
]));

const GOAL_STATUS_VALUES = Object.freeze(new Set([
  '',
  'in_progress',
  'completed',
  'blocked',
  'paused',
  'usageLimited',
  'budgetLimited',
]));

function clipText(value, maxChars) {
  const text = typeof value === 'string'
    ? value.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
    : '';
  if (!text || !Number.isInteger(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  if (maxChars === 1) return '…';
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function normalizeTimestamp(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  const time = Date.parse(trimmed);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function parseTimestampToMs(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return 0;
  const time = Date.parse(trimmed);
  return Number.isFinite(time) ? time : 0;
}

function positiveIntOrNull(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function nonNegativeNumberOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function nonNegativeIntOrDefault(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function normalizeGoalStatus(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return GOAL_STATUS_VALUES.has(normalized) ? normalized : '';
}

// Chase-accounting fields shared by both normalizers. `intent` resets the
// counters (a user edit is treated as a fresh chase); the full normalizer and
// snapshot applies preserve them.
function chaseAccounting(value, { reset } = { reset: false }) {
  if (reset) {
    return {
      chasing: value?.chasing === true,
      continuationCount: 0,
      continuationLastAt: '',
      continuationLastTokensUsed: null,
      continuationNoProgress: 0,
    };
  }
  return {
    chasing: value?.chasing === true,
    continuationCount: nonNegativeIntOrDefault(value?.continuationCount ?? value?.continuation_count, 0),
    continuationLastAt: normalizeTimestamp(value?.continuationLastAt ?? value?.continuation_last_at),
    continuationLastTokensUsed: nonNegativeNumberOrNull(
      value?.continuationLastTokensUsed ?? value?.continuation_last_tokens_used,
    ),
    continuationNoProgress: nonNegativeIntOrDefault(value?.continuationNoProgress ?? value?.continuation_no_progress, 0),
  };
}

// Strict intent normalization used by the PATCH path: only the user-writable
// fields are kept, and any stale codex snapshot is reset (a user edit means the
// codex-side goal is now stale until the next turn re-applies it). `chasing` is
// preserved from the input so editing the objective mid-chase does not silently
// stop the chase; the counters are reset because the objective changed.
export function normalizeSessionGoalIntent(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const objective = clipText(value.objective || '', MAX_GOAL_OBJECTIVE_CHARS);
  if (!objective) return null;
  return {
    version: 1,
    objective,
    tokenBudget: positiveIntOrNull(value.tokenBudget ?? value.token_budget),
    enabled: value.enabled === false ? false : true,
    ...chaseAccounting(value, { reset: true }),
    status: '',
    tokensUsed: null,
    timeUsedSeconds: null,
    updatedAt: '',
  };
}

// Full normalization (intent + snapshot) used by the meta-store normalizer and
// by the finalize writeback. Accepts snake_case fallbacks for fields that may
// arrive from codex payloads.
export function normalizeSessionGoal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const objective = clipText(value.objective || '', MAX_GOAL_OBJECTIVE_CHARS);
  if (!objective) return null;
  return {
    version: 1,
    objective,
    tokenBudget: positiveIntOrNull(value.tokenBudget ?? value.token_budget),
    enabled: value.enabled === false ? false : true,
    ...chaseAccounting(value, { reset: false }),
    status: normalizeGoalStatus(value.status),
    tokensUsed: nonNegativeNumberOrNull(value.tokensUsed ?? value.tokens_used),
    timeUsedSeconds: nonNegativeNumberOrNull(value.timeUsedSeconds ?? value.time_used_seconds),
    updatedAt: normalizeTimestamp(value.updatedAt),
  };
}

// Merge a codex-side goal snapshot into an existing goal intent, returning the
// next goal object (or null if there is no intent to attach the snapshot to).
// Preserves the user's objective/tokenBudget/enabled and the chase accounting;
// only the snapshot fields and updatedAt are replaced.
export function applyGoalSnapshot(existingGoal, snapshot) {
  const base = normalizeSessionGoal(existingGoal);
  if (!base) return null;
  if (!snapshot || typeof snapshot !== 'object') return base;
  const next = {
    ...base,
    status: normalizeGoalStatus(snapshot.status),
    tokensUsed: nonNegativeNumberOrNull(snapshot.tokensUsed ?? snapshot.tokens_used),
    timeUsedSeconds: nonNegativeNumberOrNull(snapshot.timeUsedSeconds ?? snapshot.time_used_seconds),
    updatedAt: normalizeTimestamp(snapshot.updatedAt || snapshot.updatedAtIso),
  };
  return next;
}

// Build the compact intent payload carried into the run manifest for the codex
// app-server sidecar. Returns null when goal mode is off or no objective is set.
export function buildCodexGoalIntent(goal) {
  const normalized = normalizeSessionGoal(goal);
  if (!normalized || normalized.enabled === false) return null;
  if (!normalized.objective) return null;
  return {
    objective: normalized.objective,
    tokenBudget: normalized.tokenBudget,
  };
}

// Decide whether a goal in chasing mode should auto-continue after a finalized
// codex turn. Returns { continue, hardStop, reason, streak }:
//   - continue=true  -> the caller fires the next continuation turn and records
//                       accounting (count+1, lastAt=now, lastTokensUsed=current,
//                       noProgress=streak).
//   - continue=false, hardStop=true -> the caller clears goal.chasing and posts
//                       a status event; the user must hit "重新开始" to resume.
//   - continue=false, hardStop=false -> a soft skip (not chasing / disabled /
//                       no goal); the caller does nothing.
// `nowMs` is the current epoch-ms (passed in for deterministic tests).
export function shouldContinueGoal({ goal, nowMs } = {}) {
  const g = normalizeSessionGoal(goal);
  if (!g) return { continue: false, hardStop: false, reason: 'no-goal', streak: 0 };
  if (g.enabled === false) return { continue: false, hardStop: false, reason: 'disabled', streak: 0 };
  if (g.chasing !== true) return { continue: false, hardStop: false, reason: 'not-chasing', streak: 0 };

  // Only an actively in-progress goal auto-continues. completed/blocked/paused/
  // usageLimited/budgetLimited and an unreported ('') status all hard-stop so a
  // stalled or finished goal does not spin.
  if (g.status !== 'in_progress') {
    return { continue: false, hardStop: true, reason: `status:${g.status || 'none'}`, streak: 0 };
  }

  // Budget wall.
  if (Number.isFinite(g.tokenBudget) && g.tokenBudget > 0) {
    const used = Number.isFinite(g.tokensUsed) ? g.tokensUsed : 0;
    if (used >= g.tokenBudget) {
      return { continue: false, hardStop: true, reason: 'budget-exhausted', streak: 0 };
    }
  }

  // Count cap.
  const count = Number.isFinite(g.continuationCount) ? g.continuationCount : 0;
  if (count >= MAX_GOAL_CONTINUATIONS) {
    return { continue: false, hardStop: true, reason: 'max-continuations', streak: 0 };
  }

  // Rate cap (skipped on the first continuation of a chase, which has no lastAt).
  const lastAtMs = parseTimestampToMs(g.continuationLastAt);
  if (lastAtMs && Number.isFinite(nowMs) && (nowMs - lastAtMs) < MIN_CONTINUATION_GAP_MS) {
    return { continue: false, hardStop: true, reason: 'rate-limited', streak: 0 };
  }

  // No-progress: did tokensUsed advance versus the last recorded baseline?
  const currentUsed = Number.isFinite(g.tokensUsed) ? g.tokensUsed : null;
  const baseline = (g.continuationLastTokensUsed == null) ? null : g.continuationLastTokensUsed;
  const madeProgress = baseline == null
    ? true
    : (currentUsed == null ? false : currentUsed > baseline);
  const streak = madeProgress
    ? 0
    : (Number.isFinite(g.continuationNoProgress) ? g.continuationNoProgress + 1 : 1);
  if (streak >= GOAL_NO_PROGRESS_LIMIT) {
    return { continue: false, hardStop: true, reason: 'no-progress', streak };
  }

  return { continue: true, hardStop: false, reason: 'ok', streak };
}

// The (hidden) user-message text used to launch a goal-continuation turn. Kept
// short because the codex sidecar re-applies the goal via threadGoal/set on
// every turn start; this just nudges the model to resume without redoing work.
export function buildGoalContinuationPrompt(goal) {
  const objective = normalizeSessionGoal(goal)?.objective || '';
  return `Continue pursuing the goal: "${objective}". Pick up where the previous turn left off and do not redo work already completed. If the goal is now fully achieved, stop and briefly summarize what was done.`;
}

// Prompt-only runtimes have no provider goal channel: the goal objective travels
// per-turn inside the rendered prompt. This covers Claude Code subprocesses and
// AgY's non-interactive `--print` path; neither runtime gets a fake native goal
// status or mid-turn control channel.
const CLAUDE_RUNTIME_FAMILIES = Object.freeze(new Set([
  'claude-stream-json',
  'claude-stream-json-bidi',
]));

export function isClaudeRuntimeFamily(family) {
  return CLAUDE_RUNTIME_FAMILIES.has(String(family || '').trim());
}

export function isAgyRuntimeFamily(family) {
  return AGY_RUNTIME_FAMILIES.has(String(family || '').trim());
}

export function isPromptGoalRuntimeFamily(family) {
  return isClaudeRuntimeFamily(family) || isAgyRuntimeFamily(family);
}

export function buildPromptGoalSection(goal) {
  const normalized = normalizeSessionGoal(goal);
  if (!normalized || normalized.enabled === false) return '';
  if (!normalized.objective) return '';
  const budget = Number.isFinite(normalized.tokenBudget) && normalized.tokenBudget > 0
    ? ` Token budget: ${normalized.tokenBudget}.`
    : '';
  return `Active goal (applies to every turn until completed or cleared): "${normalized.objective}".${budget}`;
}

// Kept as provider-named aliases for existing callers and tests.
export function buildClaudeGoalSection(goal) {
  return buildPromptGoalSection(goal);
}

export function buildAgyGoalSection(goal) {
  return buildPromptGoalSection(goal);
}

// Completion heuristic for runtimes without a goal-status channel.
// The continuation prompt asks the model to announce completion and summarize
// once the goal is achieved; a conservative phrase match on the tail of the
// final assistant text treats that announcement as a completed status.
// Conservative by design: a missed match just continues the chase to the
// count/budget caps, while a false match ends it one turn early.
const GOAL_ACHIEVEMENT_PATTERNS = Object.freeze([
  /\bgoal\s+(?:is|was|has been|has)\s+(?:now\s+)?(?:fully\s+|completely\s+)?(?:achieved|accomplished|fulfilled|completed|complete|finished|done|met|reached)\b/i,
  /\b(?:all|every)\s+(?:of\s+the\s+)?(?:goal\s*)?(?:objectives|requirements|items|tasks)\s+(?:are|were|have been)\s+(?:fully\s+|completely\s+)?(?:achieved|accomplished|completed|complete|fulfilled|done|met)\b/i,
  /目标\s*(?:已经|已|经)\s*(?:完全|全部|基本)?\s*(?:达成|完成|实现|满足)/,
  /(?:本次|本回合)\s*(?:任务|目标)\s*(?:已经|已)?\s*(?:全部|完全|彻底)?\s*(?:达成|完成)/,
]);

export function isGoalAchievementHeuristicHit(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  // The summary lives at the end of the turn; scanning only the tail keeps
  // hypothetical or mid-work mentions ("if the goal were achieved…") inert.
  return GOAL_ACHIEVEMENT_PATTERNS.some((pattern) => pattern.test(normalized.slice(-800)));
}

// Synthesize a goal snapshot for runtimes without a goal-status channel
// (Claude and AgY). Codex reports status/usage via thread/goal/updated; prompt-
// only runtimes do not, so at chase-check time the backend derives the snapshot
// from the finalized turn: status is in_progress unless the model announced completion
// (see isGoalAchievementHeuristicHit), and tokensUsed accumulates the turn's
// usage so the budget and no-progress guards keep working. A null
// turnTokensUsed leaves the previous total untouched (no usage data cannot be
// verified as progress, so the no-progress guard may conservatively trip).
export function synthesizePromptGoalSnapshot(goal, { turnTokensUsed = null, achieved = false, updatedAt = '' } = {}) {
  const previousUsed = Number.isFinite(goal?.tokensUsed) ? goal.tokensUsed : null;
  const turnTokens = Number.isFinite(turnTokensUsed) ? turnTokensUsed : null;
  const tokensUsed = turnTokens == null
    ? previousUsed
    : (previousUsed == null ? 0 : previousUsed) + turnTokens;
  return applyGoalSnapshot(goal, {
    status: achieved ? 'completed' : 'in_progress',
    tokensUsed,
    timeUsedSeconds: null,
    updatedAt: typeof updatedAt === 'string' && updatedAt ? updatedAt : '',
  });
}

// Kept as a provider-named alias for existing callers and tests.
export function synthesizeClaudeGoalSnapshot(goal, options = {}) {
  return synthesizePromptGoalSnapshot(goal, options);
}

// Walk normalized run events (newest-first) and return the latest codex goal
// snapshot seen during the turn, or null if none. Returns `{ cleared: true }`
// when the most recent goal event was a clear. Used at run finalize to mirror
// codex-side goal status into session.goal without touching the objective.
export function extractCodexGoalSnapshotFromEvents(events = []) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const evt = events[i];
    if (!evt || typeof evt !== 'object') continue;
    if (evt.codexGoalEvent === 'cleared') {
      return { cleared: true, updatedAt: '' };
    }
    if (evt.codexGoalEvent === 'updated' || typeof evt.codexGoalStatus === 'string') {
      const status = typeof evt.codexGoalStatus === 'string' ? evt.codexGoalStatus : '';
      const hasUsage = Number.isFinite(evt.codexGoalTokensUsed)
        || Number.isFinite(evt.codexGoalTokenBudget);
      if (!status && !hasUsage) continue;
      return {
        cleared: false,
        status,
        tokensUsed: Number.isFinite(evt.codexGoalTokensUsed) ? evt.codexGoalTokensUsed : null,
        timeUsedSeconds: Number.isFinite(evt.codexGoalTimeUsedSeconds) ? evt.codexGoalTimeUsedSeconds : null,
        updatedAt: typeof evt.codexGoalUpdatedAt === 'string' ? evt.codexGoalUpdatedAt : '',
      };
    }
  }
  return null;
}

export {
  MAX_GOAL_OBJECTIVE_CHARS,
  MAX_GOAL_CONTINUATIONS,
  MIN_CONTINUATION_GAP_MS,
  GOAL_NO_PROGRESS_LIMIT,
  GOAL_CONTINUE_INTERNAL_OPERATION,
  AGY_RUNTIME_FAMILIES,
};
