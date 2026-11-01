#!/usr/bin/env node

// Deterministic approval replay stress. Events are synthetic and are fed only
// to pure resolver/projection functions; no provider, socket, executor, or
// filesystem history is touched.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { buildOperationProjection } from '../chat/operation-projection.mjs';
import { buildRunActivityProjection } from '../chat/run-activity-projection.mjs';

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
const resolvePendingApprovalEvent = context.resolvePendingApprovalEvent;

function request(approvalId, extra = {}) {
  return {
    type: 'approval_request',
    approvalId,
    kind: 'command',
    command: 'sudo systemctl restart nginx',
    status: 'pending',
    providerItemId: 'item-1',
    timestamp: 100,
    ...extra,
  };
}

function response(approvalId, extra = {}) {
  return {
    type: 'approval_response',
    approvalId,
    decision: 'approved',
    status: 'approved',
    timestamp: 200,
    ...extra,
  };
}

function batchRequest(batchId, extra = {}) {
  return {
    type: 'privileged_batch_request',
    batchId,
    runId: 'run-1',
    other: [{ opId: 'other-1', command: 'systemctl restart nginx' }],
    delete: [{ opId: 'delete-1', command: 'rm -rf /var/cache/x' }],
    ...extra,
  };
}

function batchResponse(batchId, category) {
  return { type: 'privileged_batch_response', batchId, category, decisions: {} };
}

function activity(events) {
  return buildRunActivityProjection(events, {
    sessionRunning: true,
    run: { runtimeFamily: 'codex', providerCapabilities: { supportsInterrupt: true } },
  });
}

// 1. Same request duplicated across HTTP, WS invalidation and full history
// refresh: one pending identity, one operation, one action-required activity.
{
  const events = [
    {
      type: 'tool_use',
      seq: 1,
      runId: 'run-1',
      providerItemId: 'item-1',
      toolName: 'Bash',
      toolInput: { command: 'sudo systemctl restart nginx' },
      operationLifecycle: 'started',
      timestamp: 50,
    },
    ...Array.from({ length: 100 }, (_, index) => request('claude:dup-1', { seq: index + 2 })),
  ];
  assert.equal(resolvePendingApprovalEvent(events)?.approvalId, 'claude:dup-1');
  assert.equal(activity(events).state, 'waiting_user');
  assert.equal(activity(events).actionRequired, true);
  const projection = buildOperationProjection(events);
  assert.equal(projection.operations.length, 1, 'duplicate requests must not create duplicate operations');
  assert.equal(projection.operations[0].state, 'waiting_approval');
}

// 2. A response can arrive before a replayed request in the merged history;
// the response still closes every request with that identity.
{
  const events = [response('claude:early-close'), ...Array.from(
    { length: 100 },
    (_, index) => request('claude:early-close', { seq: index + 1 }),
  )];
  assert.equal(resolvePendingApprovalEvent(events), null);
  assert.equal(activity(events).actionRequired, false);
  assert.equal(activity(events).state, 'working');
}

// 3. Multiple approvals may coexist, but only the newest unresolved one is
// actionable; resolving it reveals the previous one deterministically.
{
  const events = [request('claude:a'), request('claude:b'), request('claude:c'), response('claude:c')];
  assert.equal(resolvePendingApprovalEvent(events)?.approvalId, 'claude:b');
  assert.equal(activity(events).detail, 'sudo systemctl restart nginx');
}

// 4. Privileged batches are resolved per non-empty category. Replayed request
// events do not reopen either category once both responses exist.
{
  const open = [
    ...Array.from({ length: 100 }, () => batchRequest('batch-1')),
    batchResponse('batch-1', 'other'),
  ];
  assert.equal(resolvePendingApprovalEvent(open)?.approvalId, 'batch-1');
  assert.equal(activity(open).actionRequired, true);
  const closed = [...open, batchResponse('batch-1', 'delete')];
  assert.equal(resolvePendingApprovalEvent(closed), null);
  const closedForProjection = [
    ...open,
    batchResponse('batch-1', 'privileged_other'),
    batchResponse('batch-1', 'destructive_delete'),
  ];
  assert.equal(activity(closedForProjection).actionRequired, false);
}

// 5. Resolver and projection remain deterministic under repeated evaluation.
{
  const events = [request('claude:stable'), response('claude:stable')];
  const first = JSON.stringify({ pending: resolvePendingApprovalEvent(events), activity: activity(events) });
  for (let index = 0; index < 100; index += 1) {
    assert.equal(JSON.stringify({ pending: resolvePendingApprovalEvent(events), activity: activity(events) }), first);
  }
}

console.log('approval-replay-stress: 5 scenarios passed (100x duplicate/replay coverage)');
