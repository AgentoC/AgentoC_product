#!/usr/bin/env node
// Replay-gate regression for resolvePendingApprovalEvent (session-http-helpers).
//
// Providers replay old approval records into later runs — an AskUserQuestion
// or plan artifact reappears as approval_request / awaiting_decision AFTER the
// original was already resolved. A single back-to-front scan would hit the
// replayed record first (its closing signal not yet collected) and mark it
// pending, re-opening the Decision Sheet for an approval that ended long ago.
// The gate must collect every closing signal over the whole list first.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import vm from 'vm';

const source = readFileSync(new URL('../static/chat/session-http-helpers.js', import.meta.url), 'utf8');
const context = {
  console,
  atob: (value) => Buffer.from(value, 'base64').toString('binary'),
  URL,
  setTimeout,
  clearTimeout,
  globalThis: {},
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context);
const resolve = context.resolvePendingApprovalEvent;

function request(approvalId, extra = {}) {
  return { type: 'approval_request', approvalId, kind: 'question', status: 'pending', ...extra };
}
function response(approvalId) {
  return { type: 'approval_response', approvalId, status: 'approved', decision: 'approved' };
}
function plan(planId, state, extra = {}) {
  return { type: 'plan', planId, state, planIntent: 'proposal', ...extra };
}

// --- replay after a closing signal (provider re-emits an old approval) ---
{
  const events = [
    request('claude:a1'),
    response('claude:a1'),
    request('claude:a1'), // replayed into a later run — same id, already closed
  ];
  assert.equal(resolve(events), null, 'a replayed approval_request whose id already got an approval_response must NOT be pending');
}

// --- closing signal BEFORE the request in the list (odd ordering) ---
{
  const events = [
    response('claude:a2'),
    request('claude:a2'),
  ];
  assert.equal(resolve(events), null, 'an approval_request with a prior approval_response (any position) must NOT be pending');
}

// --- genuinely pending still pops ---
{
  const events = [
    request('claude:a3'),
    request('claude:a4'),
  ];
  const result = resolve(events);
  assert.equal(result?.approvalId, 'claude:a4', 'the newest unresolved approval_request must win');
}

// --- terminal status on the request itself suppresses it ---
{
  const events = [request('claude:a5', { status: 'cancelled' })];
  assert.equal(resolve(events), null, 'a request already in a terminal status must NOT be pending');
}

// --- plan proposal: awaiting_decision with no stale state still pops ---
{
  const events = [plan('run-1', 'awaiting_decision')];
  const result = resolve(events);
  assert.equal(result?.approvalId, 'plan:run-1', 'a live plan proposal must synthesize its plan approval');
  assert.equal(result?.kind, 'plan', 'synthesized approval kind must be plan');
  assert.equal(result?.planEventRef?.planId, 'run-1', 'synthesized approval must carry planEventRef');
}

// --- plan replayed after an earlier stale state (executing earlier in the
//     timeline, awaiting_decision replayed later) must NOT pop ---
{
  const events = [
    plan('run-2', 'executing'), // first run: proposal executed
    plan('run-2', 'completed'),
    plan('run-2', 'awaiting_decision'), // later run replays the artifact
  ];
  assert.equal(resolve(events), null, 'a replayed awaiting_decision for a plan that already ran must NOT be pending');
}

// --- plan closed by an approval_response under the synthesized id ---
{
  const events = [
    plan('run-3', 'awaiting_decision'),
    { ...response('plan:run-3'), decision: 'denied', status: 'denied' },
  ];
  assert.equal(resolve(events), null, 'a plan whose synthesized id got an approval_response must NOT be pending');
}

// --- progress plans never pop ---
{
  const events = [plan('run-4', 'awaiting_decision', { planIntent: 'progress' })];
  assert.equal(resolve(events), null, 'progress plans must never bridge to the sheet');
}

// --- stale plan supersedes a later awaiting_decision of the same id ---
{
  const events = [
    plan('run-5', 'awaiting_decision'),
    plan('run-5', 'failed'),
  ];
  assert.equal(resolve(events), null, 'a later stale state must supersede the awaiting_decision record');
}

// --- privileged batch: pending until both non-empty categories resolve ---
function batchRequest(batchId, extra = {}) {
  return {
    type: 'privileged_batch_request',
    batchId,
    runId: 'r1',
    other: [{ opId: 'o1', command: 'systemctl restart nginx' }],
    delete: [{ opId: 'd1', command: 'rm -rf /var/lib/foo' }],
    risk: 'danger',
    ...extra,
  };
}
function batchResponse(batchId, category) {
  return { type: 'privileged_batch_response', batchId, category, decisions: {} };
}

// A fully pending batch resolves as the live approval (id doubles as gate key).
{
  const events = [batchRequest('b1')];
  const out = resolve(events);
  assert.ok(out, 'a pending batch must be the live approval on full-sync');
  assert.equal(out.approvalId, 'b1', 'batch id doubles as the live approval id');
  assert.equal(out.type, 'privileged_batch_request', 'the raw batch event is returned');
}

// One category resolved -> still pending (the other group is open).
{
  const events = [batchRequest('b2'), batchResponse('b2', 'other')];
  const out = resolve(events);
  assert.ok(out, 'batch with one open category must stay live');
  assert.equal(out.approvalId, 'b2', 'still the same batch');
}

// Both categories resolved -> no longer pending (refresh must not re-open it).
{
  const events = [
    batchRequest('b3'),
    batchResponse('b3', 'other'),
    batchResponse('b3', 'delete'),
  ];
  assert.equal(resolve(events), null, 'fully resolved batch must not re-open the sheet');
}

// Only the delete category is non-empty -> resolves with one response.
{
  const events = [
    batchRequest('b4', { other: [], delete: [{ opId: 'd1', command: 'rm -rf x' }] }),
    batchResponse('b4', 'delete'),
  ];
  assert.equal(resolve(events), null, 'batch with a single non-empty resolved category is done');
}

// Empty batch (no ops) is never pending.
{
  const events = [batchRequest('b5', { other: [], delete: [] })];
  assert.equal(resolve(events), null, 'empty batch must not open the sheet');
}

// Managed approved-action batch (Codex agent.create) must restore the sheet
// after a full-sync/reconnect, using batchId as the same live gate key that
// realtime-render.js compares against.
{
  const events = [{
    type: 'approved_action_batch_request',
    batchId: 'agent-b1',
    actions: [{ actionId: 'agent-a1', state: 'waiting_user' }],
  }];
  const out = resolve(events);
  assert.ok(out, 'a pending managed action must be the live approval on refresh');
  assert.equal(out.approvalId, 'agent-b1', 'managed action batch id must gate the sheet');
}

// A terminal approved-action state must prevent a replay from reopening the
// sheet after the action has completed.
{
  const events = [
    {
      type: 'approved_action_batch_request',
      batchId: 'agent-b2',
      actions: [{ actionId: 'agent-a2', state: 'waiting_user' }],
    },
    {
      type: 'approved_action_state',
      batchId: 'agent-b2',
      actionId: 'agent-a2',
      state: 'completed',
    },
  ];
  assert.equal(resolve(events), null, 'completed managed action must not reopen the sheet');
}

// If one action in a batch is terminal but another remains open, the batch is
// still pending and the review card must stay available.
{
  const events = [
    {
      type: 'approved_action_batch_request',
      batchId: 'agent-b3',
      actions: [
        { actionId: 'agent-a3-denied', state: 'waiting_user' },
        { actionId: 'agent-a3-open', state: 'waiting_user' },
      ],
    },
    {
      type: 'approved_action_state',
      batchId: 'agent-b3',
      actionId: 'agent-a3-denied',
      state: 'denied',
    },
  ];
  assert.equal(resolve(events)?.approvalId, 'agent-b3', 'an open action keeps the batch pending');
}

console.log('test-chat-approval-replay-gate: ok');
