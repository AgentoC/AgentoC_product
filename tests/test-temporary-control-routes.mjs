import assert from 'node:assert/strict';
import { test } from 'node:test';
import { temporaryControlCarrierRoute } from '../lib/temporary-control-routes.mjs';

const instanceId = 'inst_abcdefghijklmnopqrstuvwx';
const route = (method, path) => temporaryControlCarrierRoute(method,
  `/api/temporary-control/v1/instances/${instanceId}${path}`);

test('temporary control carrier maps all workbench surfaces to named operations', () => {
  assert.equal(route('GET', '/projects')?.operation, 'project.list');
  assert.equal(route('POST', '/projects')?.operation, 'project.create');
  assert.equal(route('PATCH', '/projects/project-1')?.operation, 'project.update');
  assert.equal(route('DELETE', '/sessions/session-1')?.operation, 'session.delete');
  assert.equal(route('POST', '/sessions/session-1/messages')?.operation, 'message.submit');
  assert.equal(route('POST', '/runs/run-1/approvals/approval-1')?.operation, 'approval.resolve');
  assert.equal(route('POST', '/runs/run-1/approved-actions/batch-1/resolve')?.operation,
    'approval.approved_action.resolve');
  assert.equal(route('POST', '/runs/run-1/privileged-batches/batch-1/categories/delete')?.operation,
    'approval.privileged.resolve');
  assert.equal(route('POST', '/harnesses/claude/install')?.operation, 'harness.install');
  assert.equal(route('POST', '/providers/provider-1/quota/refresh')?.operation, 'provider.quota.refresh');
  assert.equal(route('GET', '/sessions/session-1?view=summary')?.operation, 'session.read');
  assert.equal(route('GET', '/sessions?view=summary')?.operation, 'session.list');
  assert.equal(route('GET', '/sessions/session-1/events/wait?filter=all&limit=200&afterSeq=2&direction=forward&timeoutMs=15000')?.operation, 'session.events');
  assert.equal(route('GET', '/sessions/session-1/events/wait?filter=all&limit=200&afterSeq=2&direction=forward&compact=1&timeoutMs=15000')?.operation, 'session.events');
  assert.equal(route('GET', '/sessions/session-1/events?filter=visible&limit=50&direction=latest')?.operation, 'session.events');
  assert.equal(route('GET', '/sessions/session-1/events?filter=visible&limit=50&direction=before&beforeSeq=10')?.operation, 'session.events');
  assert.equal(route('GET', '/providers?tool=codex')?.operation, 'provider.list');
  assert.equal(route('GET', '/browse?path=C%3A%5Cwork&mode=directories')?.operation, 'project.browse');
  assert.equal(route('POST', '/browse/mkdir')?.operation, 'project.mkdir');
  assert.equal(route('POST', '/native-provider-oauth/jobs/job-1/input')?.operation, 'provider.oauth');
  assert.equal(route('PATCH', '/providers/agy/rotation')?.operation, 'provider.rotation.update');
  assert.equal(route('GET', '/session-creation-contract')?.operation, 'session.creation_contract');
  assert.equal(route('GET', '/session-mutation-contract')?.operation, 'session.mutation_contract');
  assert.equal(route('GET', '/models?tool=codex&provider=default')?.operation, 'harness.models');
  assert.equal(route('GET', '/runtime/summary/events?afterCursor=0&limit=100')?.operation, 'runtime.summary');
  assert.equal(route('POST', '/sessions/session-1/fork-at')?.operation, 'session.action');
  assert.equal(route('POST', '/sessions/session-1/queue')?.operation, 'session.action');
  assert.equal(route('POST', '/sessions/session-1/regenerate')?.operation, 'session.message_action');
  assert.equal(route('POST', '/sessions/session-1/confirmations/confirmation-1')?.operation, 'session.confirmation');
  assert.equal(route('POST', '/assets/upload-intents')?.operation, 'file.upload');
  assert.equal(route('PUT', '/assets/asset-1/upload')?.operation, 'file.upload');
  assert.equal(route('PATCH', '/assets/asset-1/upload')?.operation, 'file.upload');
  assert.equal(route('POST', '/assets/asset-1/finalize')?.operation, 'file.upload');
  assert.equal(route('GET', '/assets/asset-1/download')?.operation, 'file.download');
});

test('temporary control carrier rejects owner, passkey and arbitrary API paths', () => {
  assert.equal(route('POST', '/runs/run-1/privileged-batches/batch-1/categories/delete/webauthn-challenge'), null);
  assert.equal(route('GET', '/device-pairing/devices'), null);
  assert.equal(route('POST', '/providers/provider-1/export-secrets'), null);
  assert.equal(route('GET', '/projects?includeArchived=true'), null);
  assert.equal(route('GET', '/sessions/session-1?view=summary&view=full'), null);
  assert.equal(route('GET', '/sessions/session-1/events?filter=all&unknown=1'), null);
  assert.equal(route('GET', '/sessions/session-1/events?compact=2'), null);
  assert.equal(route('GET', '/projects/%2e%2e'), null);
  assert.equal(temporaryControlCarrierRoute('GET', 'https://owner.example/api/projects'), null);
});
