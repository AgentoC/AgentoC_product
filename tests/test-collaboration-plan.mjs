#!/usr/bin/env node
import assert from 'assert/strict';
import { compileCollaborationPlan, pathOverlaps } from '../chat/collaboration-plan.mjs';
import { normalizeCollaborationPolicy } from '../chat/collaboration-policy.mjs';

function makePolicy(overrides = {}) {
  return normalizeCollaborationPolicy({ role: 'manager', canDelegate: true, ...overrides });
}

function compile(defs, policy, input = {}) {
  return compileCollaborationPlan({ title: 'test plan', tasks: defs, ...input }, policy);
}

function expectPlanError(defs, code, policy = makePolicy(), match) {
  assert.throws(
    () => compile(defs, policy),
    (err) => {
      if (match && !err.message.includes(match)) return false;
      if (code) return err.code === code;
      return true;
    },
  );
}

const POLICY = makePolicy();

function testDefaults() {
  const plan = compile(
    [{ id: 'x', objective: '  Do the thing  ', agentId: '  agent-1  ' }],
    POLICY,
    { title: '  My Plan  ' },
  );
  assert.equal(plan.version, 1, 'version defaults to 1');
  assert.equal(plan.title, 'My Plan', 'title is trimmed');
  assert.equal(plan.tasks.length, 1);
  const task = plan.tasks[0];
  assert.equal(task.id, 'x');
  assert.equal(task.objective, 'Do the thing');
  assert.equal(task.agentId, 'agent-1');
  assert.equal(task.role, 'specialist', 'role defaults to specialist');
  assert.deepEqual(task.dependsOn, []);
  assert.deepEqual(task.acceptance, []);
  assert.deepEqual(task.writablePaths, []);
  assert.deepEqual(task.retry, { maxAttempts: 1, retryOn: ['transient'] });
  assert.equal(task.timeoutMs, 20 * 60 * 1000, 'timeout defaults to 20 minutes');
  assert.deepEqual(plan.gates, { independentReview: false });
  assert.ok(Object.isFrozen(plan), 'compiled plan should be frozen');
  assert.ok(Object.isFrozen(plan.tasks[0]), 'compiled tasks should be frozen');
}

function testNormalization() {
  const plan = compile(
    [{ id: 'r', objective: 'R', agentId: 'a1', role: 'REVIEWER' }],
    POLICY,
    { version: 7 },
  );
  assert.equal(plan.version, 7, 'explicit version is preserved');
  assert.equal(plan.tasks[0].role, 'reviewer', 'role is lowercased');

  const retried = compile(
    [{ id: 'x', objective: 'X', agentId: 'a1', retry: { maxAttempts: 99, retryOn: ['transient', 'bogus', 'deterministic_failure'] } }],
    POLICY,
  );
  assert.deepEqual(retried.tasks[0].retry, { maxAttempts: 5, retryOn: ['transient', 'deterministic_failure'] }, 'retry clamps maxAttempts and filters retryOn');

  const untyped = compile([{ id: 'a', objective: 'A', agentId: 'a1' }], POLICY);
  assert.equal(untyped.tasks[0].id, 'a', 'task id uses the taskId/key aliases');
  const aliased = compile([{ taskId: 'k1', objective: 'A', agentId: 'a1' }], POLICY);
  assert.equal(aliased.tasks[0].id, 'k1', 'taskId alias resolves to id');
}

function testValidationErrors() {
  expectPlanError([], 'COLLABORATION_PLAN_EMPTY');
  assert.throws(() => compileCollaborationPlan({ tasks: [{ id: 'a', objective: 'A', agentId: 'a1' }] }), { code: 'COLLABORATION_POLICY_DENIED' }, 'policy is required');

  expectPlanError(
    [
      { id: 'a', objective: 'A', agentId: 'a1' },
      { id: 'a', objective: 'B', agentId: 'a2' },
    ],
    'COLLABORATION_PLAN_DUPLICATE',
  );
  expectPlanError([{ id: 'a', agentId: 'a1' }], 'COLLABORATION_PLAN_OBJECTIVE');
  expectPlanError(
    [
      { id: 'a', objective: 'A', agentId: 'a1', dependsOn: ['b'] },
      { id: 'b', objective: 'B', agentId: 'a2', dependsOn: ['a'] },
    ],
    'COLLABORATION_PLAN_CYCLE',
  );
  expectPlanError([{ id: 'a', objective: 'A', agentId: 'a1', dependsOn: ['ghost'] }], 'COLLABORATION_PLAN_DEPENDENCY');
  expectPlanError([{ id: 'a', objective: 'A', agentId: 'a1', role: 'wizard' }], 'COLLABORATION_PLAN_ROLE');
  expectPlanError([{ id: 'a', objective: 'A', agentId: 'a1', role: 'reviewer', writablePaths: ['/tmp/x'] }], 'COLLABORATION_REVIEWER_WRITE');
  assert.throws(
    () => compileCollaborationPlan({ gates: { independentReview: true }, tasks: [{ id: 'a', objective: 'A', agentId: 'a1' }] }, POLICY),
    { code: 'COLLABORATION_REVIEW_REQUIRED' },
  );
  expectPlanError([{ id: 'a', objective: 'A' }], null, POLICY, 'agentId is required');

  const restricted = makePolicy({ allowedAgentIds: ['alice'] });
  expectPlanError([{ id: 'a', objective: 'A', agentId: 'bob' }], 'COLLABORATION_AGENT_DENIED', restricted);

  const roleRestricted = makePolicy({ allowedRoles: ['specialist'] });
  expectPlanError([{ id: 'a', objective: 'A', agentId: 'a1', role: 'reviewer' }], 'COLLABORATION_ROLE_DENIED', roleRestricted);

  // shared-exclusive permits at most one writer task.
  expectPlanError(
    [
      { id: 'w1', objective: 'W1', agentId: 'a1', writablePaths: ['/tmp/proj/src'] },
      { id: 'w2', objective: 'W2', agentId: 'a2', writablePaths: ['/tmp/proj/docs'] },
    ],
    'COLLABORATION_WORKSPACE_CONFLICT',
  );

  const small = makePolicy({ maxChildren: 2 });
  expectPlanError(
    [
      { id: 'a', objective: 'A', agentId: 'a1' },
      { id: 'b', objective: 'B', agentId: 'a2' },
      { id: 'c', objective: 'C', agentId: 'a3' },
    ],
    'COLLABORATION_CHILD_LIMIT',
    small,
  );
}

function testWorkspaceModes() {
  // git-worktree allows parallel writers with disjoint paths.
  const worktree = makePolicy({ workspacePolicy: 'git-worktree' });
  const plan = compile(
    [
      { id: 'w1', objective: 'W1', agentId: 'a1', writablePaths: ['/tmp/proj/src'] },
      { id: 'w2', objective: 'W2', agentId: 'a2', writablePaths: ['/tmp/proj/docs'] },
    ],
    worktree,
  );
  assert.equal(plan.workspacePolicy, 'git-worktree');
  assert.equal(plan.tasks.length, 2);
}

function testPathOverlaps() {
  assert.equal(pathOverlaps('/tmp/a', '/tmp/a'), true);
  assert.equal(pathOverlaps('/tmp/a/b', '/tmp/a'), true);
  assert.equal(pathOverlaps('/tmp/a', '/tmp/a/b'), true);
  assert.equal(pathOverlaps('/tmp/a/', '/tmp/a'), true);
  assert.equal(pathOverlaps('/tmp/a', '/tmp/ab'), false);
  assert.equal(pathOverlaps('/tmp/a', ''), false);
  assert.equal(pathOverlaps('', '/tmp/a'), false);
}

testDefaults();
testNormalization();
testValidationErrors();
testWorkspaceModes();
testPathOverlaps();
console.log('test-collaboration-plan: ok');
