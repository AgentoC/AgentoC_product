#!/usr/bin/env node
import assert from 'assert/strict';
import { createSessionTurnCompletionHelpers } from '../chat/session-turn-completion.mjs';
import { GOAL_CONTINUE_INTERNAL_OPERATION } from '../chat/session-goal.mjs';

// Factory-level tests for the goal-chase entry point (maybeRunGoalContinuation):
// runtime gating, claude snapshot synthesis (usage + completion heuristic) and
// the pause/continue decision against the recorded accounting.

function buildChaseHarness({
  runtimeFamily = 'claude-stream-json',
  goal = null,
  turnText = 'I made progress but there is more work left.',
  turnUsage = { totalTokens: 1200 },
  activeRunId = null,
  queueCount = 0,
} = {}) {
  const sessionState = {
    id: 'session-1',
    tool: 'fake-tool',
    activeRunId,
    followUpQueue: [],
    goal,
  };
  const calls = {
    sendMessage: [],
    appendEvent: [],
    invalidations: 0,
    metaWrites: 0,
  };

  const helpers = createSessionTurnCompletionHelpers({
    appendEvent: async (sessionId, event) => {
      calls.appendEvent.push(event);
    },
    broadcastSessionInvalidation: () => {
      calls.invalidations += 1;
    },
    getSession: async () => ({ ...sessionState }),
    getSessionQueueCount: () => queueCount,
    loadHistory: async () => [],
    loadReplySelfCheckTurnContext: async () => ({
      userMessage: { content: 'Continue the goal.' },
      assistantTurnText: turnText,
      usage: turnUsage,
    }),
    mutateSessionMeta: async (sessionId, mutator) => {
      const draft = { ...sessionState };
      const changed = mutator(draft, sessionState) === true;
      calls.metaWrites += 1;
      if (changed) {
        sessionState.goal = draft.goal;
        sessionState.updatedAt = draft.updatedAt;
      }
      return { meta: draft, changed };
    },
    nowIso: () => '2026-08-07T00:00:00.000Z',
    sendMessage: async (sessionId, text, attachments, options) => {
      calls.sendMessage.push({ sessionId, text, attachments, options });
    },
    statusEvent: (content) => ({ type: 'status', content }),
  });

  return { calls, helpers, sessionState };
}

const chaseGoal = {
  objective: 'Clean imports',
  enabled: true,
  chasing: true,
  tokenBudget: 50000,
  tokensUsed: 500,
  continuationCount: 1,
  continuationLastAt: '2026-08-07T00:00:00.000Z',
  continuationLastTokensUsed: 500,
  continuationNoProgress: 0,
};

const finalizedRun = {
  id: 'run-1',
  state: 'completed',
  tool: 'fake-tool',
  runtimeFamily: 'claude-stream-json',
};

// --- runtime gating ---

{
  const { calls, helpers } = buildChaseHarness({
    runtimeFamily: 'codex-json',
    goal: chaseGoal,
  });
  const result = await helpers.maybeRunGoalContinuation('session-1', {}, finalizedRun, {
    runtimeFamily: 'codex-json',
  });
  assert.equal(result.attempted, false, 'codex-json (CLI) is not a goal-chase runtime');
  assert.equal(calls.sendMessage.length, 0, 'no continuation fired for unsupported runtime');
}

// --- claude: mid-work turn continues the chase ---

{
  const { calls, helpers, sessionState } = buildChaseHarness({
    goal: chaseGoal,
    turnText: 'I cleaned the first directory but the tests still fail.',
  });
  const result = await helpers.maybeRunGoalContinuation('session-1', {}, finalizedRun, {});
  assert.equal(result.attempted, true, 'claude chase should attempt');
  assert.equal(result.continued, true, 'mid-work turn should continue');
  assert.equal(calls.sendMessage.length, 1, 'exactly one continuation launched');
  assert.equal(
    calls.sendMessage[0].options.internalOperation,
    GOAL_CONTINUE_INTERNAL_OPERATION,
    'continuation carries the goal_continue internal operation',
  );
  assert.ok(calls.sendMessage[0].text.includes('"Clean imports"'), 'continuation prompt embeds the objective');
  assert.equal(sessionState.goal.status, 'in_progress', 'snapshot synthesized as in_progress');
  assert.equal(sessionState.goal.tokensUsed, 1700, 'usage accumulates (500 previous + 1200 turn)');
  assert.equal(sessionState.goal.continuationCount, 2, 'continuation count recorded before launch');
}

// --- codex: missing first-turn provider snapshot still continues ---

{
  const { calls, helpers, sessionState } = buildChaseHarness({
    runtimeFamily: 'codex-app-server-json',
    goal: {
      objective: 'Clean imports',
      enabled: true,
      chasing: true,
      tokenBudget: 50000,
      tokensUsed: null,
      continuationCount: 0,
      continuationLastAt: '',
      continuationLastTokensUsed: null,
      continuationNoProgress: 0,
    },
  });
  const result = await helpers.maybeRunGoalContinuation('session-1', {}, {
    ...finalizedRun,
    runtimeFamily: 'codex-app-server-json',
  }, { runtimeFamily: 'codex-app-server-json' });
  assert.equal(result.continued, true, 'missing Codex snapshot must not stop a fresh chase');
  assert.equal(calls.sendMessage.length, 1, 'Codex continuation launches after inferred in_progress state');
  assert.equal(sessionState.goal.status, 'in_progress', 'missing snapshot is inferred as in_progress');
}

// --- AgY: non-interactive prompt-only goal continues without steer ---

{
  const { calls, helpers, sessionState } = buildChaseHarness({
    runtimeFamily: 'agy-stream-json',
    goal: chaseGoal,
    turnText: 'The report is partly prepared; the remaining files still need review.',
  });
  const result = await helpers.maybeRunGoalContinuation('session-1', {}, {
    ...finalizedRun,
    runtimeFamily: 'agy-stream-json',
  }, { runtimeFamily: 'agy-stream-json' });
  assert.equal(result.attempted, true, 'AgY goal chase should run for prompt-only runtime');
  assert.equal(result.continued, true, 'AgY mid-work turn should continue');
  assert.equal(calls.sendMessage.length, 1, 'AgY should receive one automatic continuation');
  assert.equal(sessionState.goal.status, 'in_progress', 'AgY snapshot should be synthesized as in_progress');
  assert.equal(sessionState.goal.tokensUsed, 1700, 'AgY usage should feed goal accounting');
}

// --- claude: completion announcement stops the chase ---

{
  const { calls, helpers, sessionState } = buildChaseHarness({
    goal: chaseGoal,
    turnText: 'The goal is now fully achieved. Here is a summary of what was done.',
  });
  const result = await helpers.maybeRunGoalContinuation('session-1', {}, finalizedRun, {});
  assert.equal(result.attempted, true, 'chase check should run');
  assert.equal(result.halted, 'status:completed', 'announced completion hard-stops the chase');
  assert.equal(calls.sendMessage.length, 0, 'no continuation fired after completion');
  assert.equal(sessionState.goal.chasing, false, 'chasing cleared on hard stop');
  assert.equal(sessionState.goal.status, 'completed', 'snapshot marked completed');
  assert.ok(
    calls.appendEvent.some((event) => typeof event?.content === 'string' && event.content.includes('chase finished')),
    'halt posts a status event',
  );
}

// --- claude: busy session soft-skips ---

{
  const { calls, helpers } = buildChaseHarness({
    goal: chaseGoal,
    activeRunId: 'run-other',
  });
  const result = await helpers.maybeRunGoalContinuation('session-1', {}, finalizedRun, {});
  assert.equal(result.attempted, false, 'busy session should soft-skip');
  assert.equal(result.skipped, 'busy', 'skip reason reported');
  assert.equal(calls.sendMessage.length, 0, 'no continuation while busy');
}

// --- duplicate finalizers: single-flight + claim allow one continuation ---

{
  const { calls, helpers } = buildChaseHarness({
    goal: {
      ...chaseGoal,
      continuationCount: 0,
      continuationLastAt: '',
      continuationLastTokensUsed: null,
      continuationNoProgress: 0,
    },
  });
  const results = await Promise.all([
    helpers.maybeRunGoalContinuation('session-1', {}, finalizedRun, {}),
    helpers.maybeRunGoalContinuation('session-1', {}, finalizedRun, {}),
  ]);
  assert.equal(calls.sendMessage.length, 1, 'duplicate finalizers must launch one continuation');
  assert.equal(results[0].continued, true, 'the first finalizer continues');
  assert.equal(results[1].continued, true, 'the duplicate observes the single-flight result');
}

console.log('test-session-goal-chase: ok');
