#!/usr/bin/env node
// Contract tests for run auth-expired classification and local recovery.
// Mirrors docs/cross-device-credential-recovery-and-model-catalog-plan.md §二.
import assert from 'node:assert/strict';

import {
  AUTH_RETRY_LIMIT_DEFAULT,
  buildToolCallIdempotencyKey,
  classifyRunAuthFailure,
  markRunAuthRecovered,
  mergeRunAuthRecoveryState,
  normalizeRunAuthRecoveryState,
  planRunAuthRecovery,
} from '../lib/provider-runtime/run-auth-recovery.mjs';

// --- classification -----------------------------------------------------------

assert.equal(classifyRunAuthFailure({ preview: '401 unauthorized: token expired' }), 'auth-expired');
assert.equal(classifyRunAuthFailure({ preview: '请求失败：请登录后重试' }), 'auth-expired');
assert.equal(classifyRunAuthFailure({ error: 'authentication required' }), 'auth-expired');
assert.equal(classifyRunAuthFailure({ preview: 'refresh token has been revoked' }), 'reauth-required');
assert.equal(
  classifyRunAuthFailure({
    preview: 'systemError: Your access token could not be refreshed because your refresh token was already used.',
  }),
  'reauth-required',
);
assert.equal(classifyRunAuthFailure({ preview: 'must re-authenticate' }), 'reauth-required');
// stop-class wins over generic 401 in the same preview
assert.equal(classifyRunAuthFailure({ preview: '401: refresh token revoked' }), 'reauth-required');
// non-auth exits must never classify as auth failures
assert.equal(classifyRunAuthFailure({ preview: 'Process exited with code 1' }), '');
assert.equal(classifyRunAuthFailure({ preview: 'model not found: gpt-x' }), '');
assert.equal(classifyRunAuthFailure({ preview: 'ECONNREFUSED 127.0.0.1:443' }), '');
assert.equal(classifyRunAuthFailure({}), '');

// --- idempotency keys ----------------------------------------------------------

assert.equal(
  buildToolCallIdempotencyKey({ runId: 'run_1', turnId: 'turn_2', toolCallId: 'call_3' }),
  'run_1:turn_2:call_3',
);
assert.equal(buildToolCallIdempotencyKey({ runId: 'run_1', toolCallId: 'call_3' }), '');

// --- state normalization ---------------------------------------------------------

const normalized = normalizeRunAuthRecoveryState({
  authCredentialVersion: 7,
  authRetryCount: 1,
  authRetryState: 'auth_retrying',
  resumeAttempt: 1,
  resumeId: 'thread_abc',
  credentialInstanceId: 'instance_abc',
  lastAuthFailureClass: 'auth-expired',
  sneakyToken: 'should-not-exist',
});
assert.equal(normalized.authCredentialVersion, 7);
assert.equal(normalized.authRetryState, 'auth_retrying');
assert.equal(normalized.authRetryLimit, AUTH_RETRY_LIMIT_DEFAULT);
assert.equal(normalized.credentialInstanceId, 'instance_abc');
assert.equal(normalized.lastAuthFailureClass, 'auth-expired');
assert.equal('sneakyToken' in normalized, false, 'unknown fields must be dropped');
assert.deepEqual(
  normalizeRunAuthRecoveryState(null),
  { authCredentialVersion: null, authRetryCount: 0, authRetryState: 'none', resumeAttempt: 0, resumeId: '', authRetryLimit: 2 },
);

const mergedRecovery = mergeRunAuthRecoveryState(
  {
    authCredentialVersion: 8,
    credentialInstanceId: 'instance_abc',
    authRetryCount: 1,
    authRetryState: 'auth_retrying',
    resumeAttempt: 1,
    resumeId: 'thread_abc',
    lastAuthFailureClass: 'auth-expired',
  },
  {
    authCredentialVersion: 7,
    authRetryCount: 0,
    authRetryState: 'none',
    resumeAttempt: 0,
    resumeId: '',
  },
);
assert.equal(mergedRecovery.authCredentialVersion, 8, 'credential version must not regress');
assert.equal(mergedRecovery.authRetryCount, 1, 'retry count must not regress');
assert.equal(mergedRecovery.authRetryState, 'auth_retrying', 'recovery state must not regress');
assert.equal(mergedRecovery.credentialInstanceId, 'instance_abc', 'credential chain must survive merge');
assert.equal(mergedRecovery.lastAuthFailureClass, 'auth-expired');

// Retry progress outranks state label: a late auth_recovered(count=1) must
// not overwrite a newer auth_retrying(count=2) snapshot.
const retryProgress = mergeRunAuthRecoveryState(
  {
    authCredentialVersion: 9,
    credentialInstanceId: 'instance_abc',
    authRetryCount: 2,
    authRetryState: 'auth_retrying',
    resumeAttempt: 2,
    resumeId: 'thread_new',
  },
  {
    authCredentialVersion: 9,
    credentialInstanceId: 'instance_abc',
    authRetryCount: 1,
    authRetryState: 'auth_recovered',
    resumeAttempt: 1,
    resumeId: 'thread_old',
  },
);
assert.equal(retryProgress.authRetryCount, 2);
assert.equal(retryProgress.resumeAttempt, 2);
assert.equal(retryProgress.authRetryState, 'auth_retrying');
assert.equal(retryProgress.resumeId, 'thread_new');

// A foreign credential instance fails closed and keeps the current account
// chain, even when the foreign snapshot carries a higher version.
const accountMismatch = mergeRunAuthRecoveryState(
  {
    authCredentialVersion: 4,
    credentialInstanceId: 'instance_current',
    authRetryCount: 1,
    authRetryState: 'auth_retrying',
    resumeAttempt: 1,
    resumeId: 'thread_current',
  },
  {
    authCredentialVersion: 12,
    credentialInstanceId: 'instance_foreign',
    authRetryCount: 2,
    authRetryState: 'auth_retrying',
    resumeAttempt: 2,
    resumeId: 'thread_foreign',
  },
);
assert.equal(accountMismatch.authCredentialVersion, 4);
assert.equal(accountMismatch.credentialInstanceId, 'instance_current');
assert.equal(accountMismatch.resumeId, 'thread_current');
assert.equal(accountMismatch.authRetryState, 'reauth_required');
assert.equal(accountMismatch.lastAuthFailureClass, 'account-mismatch');

const terminalRecovery = mergeRunAuthRecoveryState(
  { authCredentialVersion: 8, authRetryCount: 2, authRetryState: 'auth_retry_exhausted' },
  { authCredentialVersion: 9, authRetryCount: 0, authRetryState: 'none' },
);
assert.equal(terminalRecovery.authRetryState, 'auth_retry_exhausted');

// --- recovery planning -----------------------------------------------------------

const credential = (version, instanceId = 'inst-a') => ({
  credentialInstanceId: instanceId,
  credentialVersion: version,
});

// happy path: newer credential available → retry with preserved resume ids
const retrying = planRunAuthRecovery({
  run: {
    failureReason: '401 unauthorized',
    codexThreadId: 'thread_abc',
    authRecovery: { authCredentialVersion: 7, authRetryCount: 0 },
  },
  latestCredential: credential(8),
});
assert.equal(retrying.decision, 'retry');
assert.equal(retrying.next.authRetryState, 'auth_retrying');
assert.equal(retrying.next.authRetryCount, 1);
assert.equal(retrying.next.authCredentialVersion, 8);
assert.equal(retrying.next.resumeId, 'thread_abc', 'codex thread id must survive recovery');
assert.equal(retrying.next.resumeAttempt, 1);

// claude runs resume via session id
const claudeRetry = planRunAuthRecovery({
  run: { failureReason: '请登录', claudeSessionId: 'sess_9' },
  latestCredential: credential(2),
});
assert.equal(claudeRetry.decision, 'retry');
assert.equal(claudeRetry.next.resumeId, 'sess_9');

// no newer credential → stop with human action
const staleCredential = planRunAuthRecovery({
  run: { failureReason: '401', authRecovery: { authCredentialVersion: 8, authRetryCount: 0 } },
  latestCredential: credential(8),
});
assert.equal(staleCredential.decision, 'stopped');
assert.equal(staleCredential.reason, 'no-newer-credential');
assert.equal(staleCredential.next.authRetryState, 'reauth_required');

// account mismatch chain → stop, never auto-merge
const mismatch = planRunAuthRecovery({
  run: { failureReason: '401', authRecovery: { credentialInstanceId: 'inst-a', authCredentialVersion: 3 } },
  latestCredential: credential(4, 'inst-b'),
});
assert.equal(mismatch.decision, 'stopped');

// Instance binding is independent of the version value: version 0 and a
// missing legacy version must still fail closed when the account chain differs.
for (const authRecovery of [
  { credentialInstanceId: 'inst-a', authCredentialVersion: 0 },
  { credentialInstanceId: 'inst-a' },
]) {
  const legacyMismatch = planRunAuthRecovery({
    run: { failureReason: '401', authRecovery },
    latestCredential: credential(1, 'inst-b'),
  });
  assert.equal(legacyMismatch.decision, 'stopped');
  assert.equal(legacyMismatch.reason, 'credential-unavailable');
}

// tombstoned credential → stop
const deleted = planRunAuthRecovery({
  run: { failureReason: '401', authRecovery: { credentialInstanceId: 'inst-a', authCredentialVersion: 3 } },
  latestCredential: { credentialInstanceId: 'inst-a', credentialVersion: 4, deletedAt: '2026-08-26T00:00:00.000Z' },
});
assert.equal(deleted.decision, 'stopped');
assert.equal(deleted.reason, 'credential-deleted');

// reauth-required never retries
const reauth = planRunAuthRecovery({
  run: { failureReason: 'refresh token revoked' },
  latestCredential: credential(9),
});
assert.equal(reauth.decision, 'stopped');
assert.equal(reauth.reason, 'reauth-required');

// retry budget exhaustion (limit default 2)
let run = { failureReason: '401', codexThreadId: 't1', authRecovery: { authCredentialVersion: 7, authRetryCount: 2, authRetryLimit: 2 } };
let exhausted = planRunAuthRecovery({ run, latestCredential: credential(8) });
assert.equal(exhausted.decision, 'exhausted');
assert.equal(exhausted.next.authRetryState, 'auth_retry_exhausted');

// non-auth failures are ignored entirely
const ignored = planRunAuthRecovery({
  run: { failureReason: 'Process exited with code 2' },
  latestCredential: credential(8),
});
assert.equal(ignored.decision, 'ignored');

// completed side effects block silent replay
const sideEffects = planRunAuthRecovery({
  run: { failureReason: '401', authRecovery: { authCredentialVersion: 7, authRetryCount: 0 } },
  latestCredential: credential(8),
  sideEffectsConfirmed: true,
});
assert.equal(sideEffects.decision, 'stopped');
assert.equal(sideEffects.reason, 'unconfirmed-side-effects');

// recovered marker
const recovered = markRunAuthRecovered({ authRecovery: retrying.next });
assert.equal(recovered.authRetryState, 'auth_recovered');
assert.equal(recovered.authRetryCount, 1);

console.log('test-run-auth-recovery: classification, CAS-gated retry, side-effect guard OK');
