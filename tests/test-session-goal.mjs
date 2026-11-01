#!/usr/bin/env node
import assert from 'assert/strict';

import {
  normalizeSessionGoal,
  normalizeSessionGoalIntent,
  applyGoalSnapshot,
  buildCodexGoalIntent,
  extractCodexGoalSnapshotFromEvents,
  shouldContinueGoal,
  buildGoalContinuationPrompt,
  isClaudeRuntimeFamily,
  isAgyRuntimeFamily,
  isPromptGoalRuntimeFamily,
  buildClaudeGoalSection,
  buildAgyGoalSection,
  isGoalAchievementHeuristicHit,
  synthesizeClaudeGoalSnapshot,
  MAX_GOAL_OBJECTIVE_CHARS,
  MAX_GOAL_CONTINUATIONS,
  MIN_CONTINUATION_GAP_MS,
  GOAL_NO_PROGRESS_LIMIT,
  GOAL_CONTINUE_INTERNAL_OPERATION,
} from '../chat/session-goal.mjs';

// --- normalizeSessionGoalIntent (PATCH path) ---

const intent = normalizeSessionGoalIntent({
  objective: '  Tidy the imports folder  ',
  tokenBudget: 25000,
  enabled: true,
  // user cannot set snapshot fields — they must be reset:
  status: 'completed',
  tokensUsed: 999,
});
assert.deepEqual(intent, {
  version: 1,
  objective: 'Tidy the imports folder',
  tokenBudget: 25000,
  enabled: true,
  chasing: false,
  continuationCount: 0,
  continuationLastAt: '',
  continuationLastTokensUsed: null,
  continuationNoProgress: 0,
  status: '',
  tokensUsed: null,
  timeUsedSeconds: null,
  updatedAt: '',
});
assert.equal(MAX_GOAL_OBJECTIVE_CHARS, 480);

// null / missing objective -> null (field should be dropped)
assert.equal(normalizeSessionGoalIntent({ objective: '' }), null);
assert.equal(normalizeSessionGoalIntent({ objective: '   ' }), null);
assert.equal(normalizeSessionGoalIntent(null), null);
assert.equal(normalizeSessionGoalIntent('not an object'), null);

// non-positive budget dropped; enabled defaults to true
assert.equal(normalizeSessionGoalIntent({ objective: 'x', tokenBudget: 0 }).tokenBudget, null);
assert.equal(normalizeSessionGoalIntent({ objective: 'x', tokenBudget: -3 }).tokenBudget, null);
assert.equal(normalizeSessionGoalIntent({ objective: 'x' }).enabled, true);
assert.equal(normalizeSessionGoalIntent({ objective: 'x', enabled: false }).enabled, false);

// objective is clipped + collapsed whitespace
const longObjective = 'a'.repeat(600);
const clipped = normalizeSessionGoalIntent({ objective: longObjective });
assert.equal(clipped.objective.length, 480);
assert.equal(clipped.objective.endsWith('…'), true);

// --- normalizeSessionGoal (full, with snapshot) ---

const full = normalizeSessionGoal({
  objective: 'Ship the report',
  status: 'in_progress',
  tokenBudget: 50000,
  tokensUsed: 12300,
  timeUsedSeconds: 42,
  updatedAt: '2026-08-06T00:00:00.000Z',
});
assert.deepEqual(full, {
  version: 1,
  objective: 'Ship the report',
  tokenBudget: 50000,
  enabled: true,
  chasing: false,
  continuationCount: 0,
  continuationLastAt: '',
  continuationLastTokensUsed: null,
  continuationNoProgress: 0,
  status: 'in_progress',
  tokensUsed: 12300,
  timeUsedSeconds: 42,
  updatedAt: '2026-08-06T00:00:00.000Z',
});

// snake_case fallbacks + invalid status dropped
assert.deepEqual(
  normalizeSessionGoal({ objective: 'x', token_budget: 10, tokens_used: 3, time_used_seconds: 1, status: 'bogus' }),
  { version: 1, objective: 'x', tokenBudget: 10, enabled: true, chasing: false, continuationCount: 0, continuationLastAt: '', continuationLastTokensUsed: null, continuationNoProgress: 0, status: '', tokensUsed: 3, timeUsedSeconds: 1, updatedAt: '' },
);
assert.equal(normalizeSessionGoal({}), null);
assert.equal(normalizeSessionGoal(null), null);

// --- applyGoalSnapshot (preserve intent, replace snapshot) ---

const userGoal = normalizeSessionGoalIntent({ objective: 'Ship the report', tokenBudget: 50000 });
const withSnapshot = applyGoalSnapshot(userGoal, {
  status: 'in_progress',
  tokensUsed: 9000,
  timeUsedSeconds: 120,
  updatedAt: '2026-08-06T00:05:00Z',
});
assert.equal(withSnapshot.objective, 'Ship the report', 'objective preserved');
assert.equal(withSnapshot.tokenBudget, 50000, 'tokenBudget preserved');
assert.equal(withSnapshot.enabled, true, 'enabled preserved');
assert.equal(withSnapshot.status, 'in_progress');
assert.equal(withSnapshot.tokensUsed, 9000);
assert.equal(withSnapshot.timeUsedSeconds, 120);
assert.equal(withSnapshot.updatedAt, '2026-08-06T00:05:00.000Z');

// snapshot into a non-existent goal -> null (nothing to attach to)
assert.equal(applyGoalSnapshot(null, { status: 'in_progress' }), null);
// null snapshot leaves the intent untouched
assert.equal(applyGoalSnapshot(userGoal, null).status, '');

// --- buildCodexGoalIntent (manifest payload) ---

assert.deepEqual(
  buildCodexGoalIntent({ objective: 'Clean imports', tokenBudget: 25000, enabled: true }),
  { objective: 'Clean imports', tokenBudget: 25000 },
);
assert.equal(buildCodexGoalIntent({ objective: 'x', enabled: false }), null, 'disabled goal yields no intent');
assert.equal(buildCodexGoalIntent({ objective: '' }), null);
assert.equal(buildCodexGoalIntent(null), null);
// budgetless goal still carries an intent with null budget
assert.deepEqual(buildCodexGoalIntent({ objective: 'x' }), { objective: 'x', tokenBudget: null });

// --- extractCodexGoalSnapshotFromEvents (finalize writeback) ---

assert.equal(extractCodexGoalSnapshotFromEvents([]), null, 'no events -> null');
assert.equal(extractCodexGoalSnapshotFromEvents([{ type: 'message' }, { type: 'usage' }]), null, 'no goal events -> null');

// latest updated wins
const snapshot = extractCodexGoalSnapshotFromEvents([
  { type: 'status', codexGoalEvent: 'updated', codexGoalStatus: 'in_progress', codexGoalTokensUsed: 1000, codexGoalTokenBudget: 50000, codexGoalTimeUsedSeconds: 10, codexGoalUpdatedAt: '2026-08-06T00:01:00Z' },
  { type: 'status', codexGoalEvent: 'updated', codexGoalStatus: 'in_progress', codexGoalTokensUsed: 9000, codexGoalTokenBudget: 30000, codexGoalTimeUsedSeconds: 120, codexGoalUpdatedAt: '2026-08-06T00:05:00Z' },
]);
assert.deepEqual(snapshot, {
  cleared: false,
  status: 'in_progress',
  tokensUsed: 9000,
  timeUsedSeconds: 120,
  updatedAt: '2026-08-06T00:05:00Z',
});

// cleared overrides an earlier update
assert.deepEqual(
  extractCodexGoalSnapshotFromEvents([
    { codexGoalEvent: 'updated', codexGoalStatus: 'in_progress', codexGoalTokensUsed: 5 },
    { codexGoalEvent: 'cleared' },
  ]),
  { cleared: true, updatedAt: '' },
);

// a cleared followed by nothing else still reports cleared (newest-first walk)
assert.deepEqual(
  extractCodexGoalSnapshotFromEvents([{ codexGoalEvent: 'cleared' }]),
  { cleared: true, updatedAt: '' },
);

// an "updated" event with no status and no usage is skipped (not meaningful)
assert.equal(
  extractCodexGoalSnapshotFromEvents([{ codexGoalEvent: 'updated' }]),
  null,
);

// --- guardrail constants ---

assert.equal(MAX_GOAL_CONTINUATIONS, 10);
assert.equal(MIN_CONTINUATION_GAP_MS, 5000);
assert.equal(GOAL_NO_PROGRESS_LIMIT, 2);
assert.equal(GOAL_CONTINUE_INTERNAL_OPERATION, 'goal_continue');

// --- chasing + accounting normalization ---

// intent preserves the chasing switch but resets the accounting (a user edit is
// a fresh chase even if the objective is unchanged).
const intentChase = normalizeSessionGoalIntent({
  objective: 'x', chasing: true, continuationCount: 7, continuation_no_progress: 3,
});
assert.equal(intentChase.chasing, true, 'intent preserves chasing');
assert.equal(intentChase.continuationCount, 0, 'intent resets count');
assert.equal(intentChase.continuationNoProgress, 0, 'intent resets no-progress');

// full normalizer preserves chasing + accounting with snake_case fallbacks.
const preserved = normalizeSessionGoal({
  objective: 'x', chasing: true,
  continuation_count: 3,
  continuation_last_at: '2026-08-06T00:00:00Z',
  continuation_last_tokens_used: 500,
  continuation_no_progress: 1,
});
assert.equal(preserved.chasing, true);
assert.equal(preserved.continuationCount, 3);
assert.equal(preserved.continuationLastAt, '2026-08-06T00:00:00.000Z');
assert.equal(preserved.continuationLastTokensUsed, 500);
assert.equal(preserved.continuationNoProgress, 1);

// accounting is preserved across a snapshot apply (only snapshot fields change).
const chaseWithSnap = applyGoalSnapshot(preserved, {
  status: 'in_progress', tokensUsed: 600, timeUsedSeconds: 5,
  updatedAt: '2026-08-06T00:01:00Z',
});
assert.equal(chaseWithSnap.chasing, true, 'chasing survives snapshot apply');
assert.equal(chaseWithSnap.continuationCount, 3, 'count survives snapshot apply');
assert.equal(chaseWithSnap.tokensUsed, 600, 'snapshot tokens applied');

// --- shouldContinueGoal predicate ---

const NOW_MS = Date.parse('2026-08-07T00:00:00.000Z');
const baseGoal = {
  objective: 'Ship it', enabled: true, chasing: true, status: 'in_progress',
  tokenBudget: 50000, tokensUsed: 1000,
  continuationCount: 0, continuationLastAt: '', continuationLastTokensUsed: null,
  continuationNoProgress: 0,
};

// happy path: first continuation (no baseline) -> continue, streak 0.
assert.deepEqual(
  shouldContinueGoal({ goal: baseGoal, nowMs: NOW_MS }),
  { continue: true, hardStop: false, reason: 'ok', streak: 0 },
);

// no goal / disabled / not chasing are soft skips (no hardStop).
assert.deepEqual(shouldContinueGoal({ goal: null, nowMs: NOW_MS }), { continue: false, hardStop: false, reason: 'no-goal', streak: 0 });
assert.deepEqual(shouldContinueGoal({ goal: { ...baseGoal, enabled: false }, nowMs: NOW_MS }), { continue: false, hardStop: false, reason: 'disabled', streak: 0 });
assert.deepEqual(shouldContinueGoal({ goal: { ...baseGoal, chasing: false }, nowMs: NOW_MS }), { continue: false, hardStop: false, reason: 'not-chasing', streak: 0 });

// terminal / unreported status hard-stops.
assert.equal(shouldContinueGoal({ goal: { ...baseGoal, status: 'completed' }, nowMs: NOW_MS }).hardStop, true);
assert.equal(shouldContinueGoal({ goal: { ...baseGoal, status: 'completed' }, nowMs: NOW_MS }).reason, 'status:completed');
assert.equal(shouldContinueGoal({ goal: { ...baseGoal, status: '' }, nowMs: NOW_MS }).reason, 'status:none');
assert.equal(shouldContinueGoal({ goal: { ...baseGoal, status: 'blocked' }, nowMs: NOW_MS }).reason, 'status:blocked');

// budget wall.
assert.equal(shouldContinueGoal({ goal: { ...baseGoal, tokenBudget: 1000, tokensUsed: 1000 }, nowMs: NOW_MS }).reason, 'budget-exhausted');
// one token of headroom is enough to keep going
assert.equal(shouldContinueGoal({ goal: { ...baseGoal, tokenBudget: 1000, tokensUsed: 999 }, nowMs: NOW_MS }).continue, true);

// count cap.
assert.equal(shouldContinueGoal({ goal: { ...baseGoal, continuationCount: MAX_GOAL_CONTINUATIONS }, nowMs: NOW_MS }).reason, 'max-continuations');

// rate cap: a continuation < MIN_CONTINUATION_GAP_MS after the last is rejected.
const recentGoal = { ...baseGoal, continuationLastAt: new Date(NOW_MS - 1000).toISOString() };
assert.equal(shouldContinueGoal({ goal: recentGoal, nowMs: NOW_MS }).reason, 'rate-limited');
// >= gap is allowed (with progress, see no-progress cases below)
const pastGapGoal = { ...baseGoal, continuationLastAt: new Date(NOW_MS - (MIN_CONTINUATION_GAP_MS + 1000)).toISOString(), continuationLastTokensUsed: 500, tokensUsed: 600 };
assert.equal(shouldContinueGoal({ goal: pastGapGoal, nowMs: NOW_MS }).continue, true, 'past the gap + progress continues');

// no-progress: tokensUsed did not advance past the baseline.
const stalledFirst = { ...baseGoal, continuationLastAt: new Date(NOW_MS - 10000).toISOString(), continuationLastTokensUsed: 500, tokensUsed: 500, continuationNoProgress: 0 };
const stalledResult = shouldContinueGoal({ goal: stalledFirst, nowMs: NOW_MS });
assert.equal(stalledResult.continue, true, 'one stalled turn is below the limit');
assert.equal(stalledResult.streak, 1, 'streak increments to 1');
const stalledSecond = { ...stalledFirst, continuationNoProgress: 1 };
const stalledSecondResult = shouldContinueGoal({ goal: stalledSecond, nowMs: NOW_MS });
assert.equal(stalledSecondResult.hardStop, true, 'second consecutive stall hard-stops');
assert.equal(stalledSecondResult.reason, 'no-progress');
assert.equal(stalledSecondResult.streak, 2);

// progress resets the streak to 0.
const recovered = { ...baseGoal, continuationLastAt: new Date(NOW_MS - 10000).toISOString(), continuationLastTokensUsed: 500, tokensUsed: 900, continuationNoProgress: 1 };
assert.equal(shouldContinueGoal({ goal: recovered, nowMs: NOW_MS }).streak, 0, 'progress resets streak');

// --- buildGoalContinuationPrompt ---

const prompt = buildGoalContinuationPrompt({ objective: 'Ship it', chasing: true });
assert.equal(typeof prompt, 'string');
assert.ok(prompt.startsWith('Continue pursuing the goal:'), 'prompt opens with the boilerplate');
assert.ok(prompt.includes('"Ship it"'), 'prompt embeds the objective');
// missing objective degrades to empty quotes but still returns boilerplate
assert.ok(buildGoalContinuationPrompt(null).includes('""'));
assert.ok(buildGoalContinuationPrompt({ objective: '' }).includes('""'));

// --- claude code runtime adaptation ---

// isClaudeRuntimeFamily
assert.equal(isClaudeRuntimeFamily('claude-stream-json'), true);
assert.equal(isClaudeRuntimeFamily('claude-stream-json-bidi'), true);
assert.equal(isClaudeRuntimeFamily('codex-app-server-json'), false);
assert.equal(isClaudeRuntimeFamily('codex-json'), false);
assert.equal(isClaudeRuntimeFamily(''), false);
assert.equal(isClaudeRuntimeFamily(null), false);
assert.equal(isAgyRuntimeFamily('agy-json'), true);
assert.equal(isAgyRuntimeFamily('agy-stream-json'), true);
assert.equal(isAgyRuntimeFamily('codex-app-server-json'), false);
assert.equal(isPromptGoalRuntimeFamily('agy-json'), true);
assert.equal(isPromptGoalRuntimeFamily('claude-stream-json-bidi'), true);
assert.equal(isPromptGoalRuntimeFamily('codex-app-server-json'), false);

// buildClaudeGoalSection (per-turn prompt block, claude has no threadGoal RPC)
const claudeSection = buildClaudeGoalSection({
  objective: 'Clean imports',
  tokenBudget: 25000,
  enabled: true,
  chasing: true,
});
assert.ok(claudeSection.includes('"Clean imports"'), 'section embeds the objective');
assert.ok(claudeSection.includes('Token budget: 25000'), 'section embeds the budget');
assert.equal(buildClaudeGoalSection({ objective: 'x', enabled: false }), '', 'disabled goal yields no section');
assert.equal(buildClaudeGoalSection({ objective: '' }), '', 'empty objective yields no section');
assert.equal(buildClaudeGoalSection(null), '', 'no goal yields no section');

const agySection = buildAgyGoalSection({
  objective: 'Prepare the report',
  tokenBudget: 12000,
  enabled: true,
});
assert.ok(agySection.includes('"Prepare the report"'), 'AgY goal section embeds the objective');
assert.ok(agySection.includes('Token budget: 12000'), 'AgY goal section embeds the budget');
assert.equal(buildAgyGoalSection({ objective: 'x', enabled: false }), '', 'disabled AgY goal yields no section');

// isGoalAchievementHeuristicHit (completion announcement on the turn tail)
assert.equal(isGoalAchievementHeuristicHit('The goal is now fully achieved. Here is a summary of what was done.'), true, 'explicit English completion');
assert.equal(isGoalAchievementHeuristicHit('All objectives have been completed, so I will stop here.'), true, 'objectives-completed phrasing');
assert.equal(isGoalAchievementHeuristicHit('目标已达成,以下是本次改动总结。'), true, 'explicit Chinese completion');
assert.equal(isGoalAchievementHeuristicHit('目标已经完全实现,本次工作结束。'), true, 'Chinese completion variant');
assert.equal(isGoalAchievementHeuristicHit('I made progress on the goal but there is more work left.'), false, 'mid-work text stays inert');
assert.equal(isGoalAchievementHeuristicHit('如果目标达成,我会停下来继续总结。'), false, 'hypothetical mention stays inert');
assert.equal(isGoalAchievementHeuristicHit('继续推进任务,下一步是重构测试。'), false, 'neutral continuation text');
assert.equal(isGoalAchievementHeuristicHit(''), false, 'empty text');
assert.equal(isGoalAchievementHeuristicHit(null), false, 'null text');

// synthesizeClaudeGoalSnapshot (claude has no thread/goal/updated channel)
const claudeBase = normalizeSessionGoal({
  objective: 'Clean imports',
  enabled: true,
  chasing: true,
  continuationCount: 2,
  continuationNoProgress: 0,
});
const syncedFirst = synthesizeClaudeGoalSnapshot(claudeBase, {
  turnTokensUsed: 1200,
  achieved: false,
  updatedAt: '2026-08-07T00:00:00Z',
});
assert.equal(syncedFirst.status, 'in_progress', 'not achieved stays in_progress');
assert.equal(syncedFirst.tokensUsed, 1200, 'first turn usage accumulates from zero');
assert.equal(syncedFirst.chasing, true, 'chase accounting preserved');
assert.equal(syncedFirst.continuationCount, 2, 'continuation counters preserved');
assert.equal(syncedFirst.objective, 'Clean imports', 'intent untouched');
const syncedDone = synthesizeClaudeGoalSnapshot(syncedFirst, {
  turnTokensUsed: 800,
  achieved: true,
  updatedAt: '2026-08-07T00:01:00Z',
});
assert.equal(syncedDone.status, 'completed', 'achieved marks completed');
assert.equal(syncedDone.tokensUsed, 2000, 'usage accumulates across turns');
const syncedNoUsage = synthesizeClaudeGoalSnapshot(
  { ...syncedFirst, tokensUsed: 1500 },
  { turnTokensUsed: null, achieved: false, updatedAt: '2026-08-07T00:02:00Z' },
);
assert.equal(syncedNoUsage.tokensUsed, 1500, 'null turn usage keeps the previous total');
assert.equal(synthesizeClaudeGoalSnapshot(null, { turnTokensUsed: 100 }), null, 'no goal yields null');

console.log('test-session-goal: ok');
