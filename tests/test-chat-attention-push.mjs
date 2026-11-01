#!/usr/bin/env node
// Focused tests for the attention-push module: describeApprovalEvent must map
// an approval_request event to the same waiting subtype the frontend shows
// (plan / danger / answer / approval), and maybeNotifyApprovalPending must
// refuse non-approval events, events without an approvalId, and unknown
// sessions — without throwing.
import assert from 'assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const { describeApprovalEvent, maybeNotifyApprovalPending } = await import(
  pathToFileURL(join(repoRoot, 'chat', 'attention-push.mjs')).href
);

// describeApprovalEvent classification
assert.equal(describeApprovalEvent({ kind: 'plan' }).kind, 'plan', 'kind=plan -> plan');
assert.equal(
  describeApprovalEvent({ kind: 'permissions' }).kind,
  'permission',
  'kind=permissions -> permission',
);
assert.equal(
  describeApprovalEvent({ kind: 'plan' }).label,
  'plan awaiting approval',
  'plan label',
);
assert.equal(
  describeApprovalEvent({ questions: ['q1'] }).kind,
  'answer',
  'questions array -> answer',
);
assert.equal(
  describeApprovalEvent({ kind: 'tool', risk: 'critical' }).kind,
  'danger',
  'risk=critical -> danger',
);
assert.equal(
  describeApprovalEvent({ kind: 'tool', tier: 'high' }).kind,
  'danger',
  'tier=high -> danger (frontend alignment)',
);
assert.equal(
  describeApprovalEvent({ kind: 'bash' }).kind,
  'approval',
  'generic bash -> approval',
);
assert.equal(
  describeApprovalEvent({}).kind,
  'approval',
  'bare event -> approval',
);

// maybeNotifyApprovalPending guards
assert.equal(describeApprovalEvent({ kind: 'question', approvalId: 'q1' }).key, 'q1');
assert.equal(describeApprovalEvent({ kind: 'question', approvalId: 'q2' }).key, 'q2');
assert.equal(describeApprovalEvent({ providerApprovalId: 'provider-q1' }).key, 'provider-q1');
assert.equal(describeApprovalEvent({ type: 'privileged_batch_request', batchId: 'batch-1' }).key, 'batch-1');
assert.equal(describeApprovalEvent({ type: 'message', batchId: 'not-an-approval' }).key, undefined);
assert.equal(describeApprovalEvent({ approvalId: { forged: true } }).key, undefined);
assert.equal(describeApprovalEvent({ approvalId: 'q1\nq2' }).key, undefined);
assert.equal(
  await maybeNotifyApprovalPending('session-x', { type: 'message', approvalId: 'a1' }),
  false,
  'non-approval_request event -> false',
);
assert.equal(
  await maybeNotifyApprovalPending('session-x', { type: 'approval_request' }),
  false,
  'approval_request without approvalId -> false',
);
assert.equal(
  await maybeNotifyApprovalPending('session-x', {
    type: 'approval_request',
    approvalId: 'progress-plan-1',
    kind: 'plan',
    planIntent: 'progress',
  }),
  false,
  'progress plan approval-shaped event -> false',
);
assert.equal(
  await maybeNotifyApprovalPending(null, { type: 'approval_request', approvalId: 'a2' }),
  false,
  'missing sessionId -> false',
);
assert.equal(
  await maybeNotifyApprovalPending('no-such-session-zzz', { type: 'approval_request', approvalId: 'a3' }),
  false,
  'unknown session resolves to false without throwing',
);

console.log('test-chat-attention-push: ok');
