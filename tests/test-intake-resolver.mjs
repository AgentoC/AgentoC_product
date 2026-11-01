#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createIntakeResolver } from '../chat/intake-resolver.mjs';

const projectA = {
  projectId: 'prj_a', projectRevision: 4, name: 'Same Product',
  rootIdentity: '/projects/a', rootStatus: 'resolved', completeness: 'complete',
  memoryVersion: 2, activeThreads: [{ sessionId: 'session-a', title: 'Fix share' }],
};
const projectB = {
  projectId: 'prj_b', projectRevision: 2, name: 'Same Product',
  rootIdentity: '/projects/b', rootStatus: 'resolved', completeness: 'complete',
  memoryVersion: 1, activeThreads: [],
};
let context = {
  targetInstanceId: 'pc-1', indexRevision: 'revision-1',
  inventoryComplete: true, truncated: false,
  projects: [projectA, projectB],
  candidates: [{ project: projectA, score: 50 }, { project: projectB, score: 50 }],
};
let modelCalls = 0;
let proposal = {
  decision: 'use_existing', projectId: 'prj_a', projectRevision: 4,
  sessionAction: 'continue_existing', existingSessionId: 'session-a',
  materialRole: 'problem_report', taskBrief: 'Fix sharing', reason: 'The request names the A root.',
};
const resolver = createIntakeResolver({
  projectIndex: { search: async () => context },
  decide: async () => { modelCalls += 1; return proposal; },
});
const input = {
  intakeId: 'intake-1', targetInstanceId: 'pc-1',
  userRequirement: 'Continue prj_a and fix sharing', sharedText: 'Screenshot text',
};
let result = await resolver.prepare(input);
assert.equal(result.decision, 'use_existing');
assert.equal(result.existingSessionId, 'session-a');
assert.ok(result.evidenceRefs.includes('project:prj_a:r4'));
assert.equal((await resolver.prepare(input)).decisionId, result.decisionId, 'unchanged evidence yields stable decision identity');

result = await resolver.prepare({ ...input, userRequirement: 'Fix sharing' });
assert.equal(result.decision, 'needs_clarification', 'equal names cannot be silently merged');

proposal = { ...proposal, existingSessionId: 'session-outside-scope' };
result = await resolver.prepare(input);
assert.equal(result.decision, 'needs_clarification', 'continued sessions must belong to the selected Project');

proposal = {
  decision: 'create_new', sessionAction: 'create_new', materialRole: 'new_requirement',
  taskBrief: 'Build the new product', reason: 'Distinct long-lived goal.',
  excludedCandidateIds: ['prj_a'],
  newProject: { name: 'New Product', purpose: 'Organize invoices', projectType: 'software', sustainedGoal: true },
};
result = await resolver.prepare({ ...input, userRequirement: 'Build an independent invoice product' });
assert.equal(result.decision, 'needs_clarification', 'new creation must exclude every plausible existing Project');
proposal.excludedCandidateIds.push('prj_b');
result = await resolver.prepare({ ...input, userRequirement: 'Build an independent invoice product' });
assert.equal(result.decision, 'create_new');
assert.equal(result.newProject.projectType, 'software');
assert.equal('rootPath' in result.newProject, false, 'model cannot choose an absolute Project path');

const callsBeforeWait = modelCalls;
context = { ...context, inventoryComplete: false };
result = await resolver.prepare(input);
assert.equal(result.decision, 'wait_context');
assert.equal(modelCalls, callsBeforeWait, 'incomplete inventory must not reach the creator');
context = { ...context, inventoryComplete: true, projects: [{ ...projectA, rootStatus: 'unresolved' }, projectB] };
result = await resolver.prepare(input);
assert.equal(result.decision, 'wait_context');
context = { ...context, projects: [projectA, projectB] };
result = await resolver.prepare({ ...input, targetInstanceId: 'pc-other' });
assert.equal(result.decision, 'wait_context');
assert.equal(result.reason, 'target_instance_changed');
console.log('test-intake-resolver: ok');
