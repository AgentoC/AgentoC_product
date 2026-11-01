// Run auth-failure classification and local recovery state.
//
// Contract (docs/cross-device-credential-recovery-and-model-catalog-plan.md §二):
//   - Only explicit authentication failures may enter automatic recovery.
//     Arbitrary non-zero exits must NOT be treated as token expiry.
//   - Recovery re-reads the latest credential version, re-materializes the
//     provider auth file, and resumes on the ORIGINAL device while preserving
//     the Codex thread id / Claude session id / AgY conversation id.
//   - Runs with completed tool side effects never silently replay: each
//     retryable tool call carries idempotencyKey = runId + turnId + toolCallId.
//   - Hard stops: revoked refresh token (reauth-required), account-identity
//     mismatch, peer unreachable for the whole budget, retry exhaustion.
//
// This module is pure state + classification; it never touches the SecretStore
// or spawns providers, so it is safe to unit-test and to import anywhere.

export const AUTH_RETRY_LIMIT_DEFAULT = 2;

export const AUTH_RETRY_STATES = new Set([
  'none',
  'auth_retrying',
  'auth_recovered',
  'auth_retry_exhausted',
  'reauth_required',
]);

// Exit/outcome classes eligible for automatic recovery. `network-error` is
// deliberately absent: transient network failures retry through existing
// provider failover, not the credential chain.
export const RUN_AUTH_FAILURE_CLASSES = new Set(['auth-expired']);

// Terminal classes that must surface a human action instead of looping.
export const RUN_AUTH_STOP_CLASSES = new Set(['reauth-required', 'account-mismatch']);

const RUN_AUTH_KNOWN_FAILURE_CLASSES = new Set([
  ...RUN_AUTH_FAILURE_CLASSES,
  ...RUN_AUTH_STOP_CLASSES,
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Classify a provider exit into an auth-related class. Inputs are non-sensitive
// previews only; the classifier must never receive token bodies.
const AUTH_EXPIRED_PATTERNS = [
  /token\s+expired/i,
  /access[_ ]token.*(expired|invalid)/i,
  /invalid[_ ]refresh[_ ]token/i,
  /refresh[_ ]token.*(expired|invalid|revoked)/i,
  /\b401\b/,
  /unauthorized/i,
  /authentication\s+(failed|required|error)/i,
  /please\s+(log ?in|sign ?in|re-?auth)/i,
  /请登录|登录已?过期|需要登录|重新登录/,
  /auth\s*expired/i,
];

const REAUTH_REQUIRED_PATTERNS = [
  /refresh[_ ]token.*(revoked|rotated)/i,
  /refresh[_ ]token.*(?:already\s+been\s+used|was\s+already\s+used|is\s+already\s+used)/i,
  /must\s+(re-?authenticate|log ?in\s+again)/i,
  /please\s+log ?out.*(?:sign|log)\s+in\s+again/i,
  /device[_ ]code\s+expired/i,
  /需要重新登录.*浏览器|browser.*re-?login/i,
];

export function classifyRunAuthFailure({ preview = '', providerErrorType = '', error = '' } = {}) {
  const text = [preview, providerErrorType, error]
    .map((part) => trimString(String(part || '')))
    .filter(Boolean)
    .join(' | ');
  if (!text) return '';
  // Stop-class patterns win: a revoked refresh token is never retryable even
  // if the same preview also matches a generic 401.
  if (REAUTH_REQUIRED_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'reauth-required';
  }
  if (AUTH_EXPIRED_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'auth-expired';
  }
  return '';
}

export function buildToolCallIdempotencyKey({ runId = '', turnId = '', toolCallId = '' } = {}) {
  const parts = [runId, turnId, toolCallId].map((value) => trimString(String(value || '')));
  if (parts.some((part) => !part)) return '';
  return parts.join(':');
}

// Normalize the non-sensitive recovery block stored on the run record. Unknown
// fields are dropped; sensitive ones (fingerprints of secrets, token text)
// never enter this shape by construction.
export function normalizeRunAuthRecoveryState(value, { retryLimit = AUTH_RETRY_LIMIT_DEFAULT } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const retryCount = Number.isSafeInteger(Number(source.authRetryCount)) && source.authRetryCount >= 0
    ? Math.floor(source.authRetryCount)
    : 0;
  const state = AUTH_RETRY_STATES.has(trimString(source.authRetryState))
    ? trimString(source.authRetryState)
    : 'none';
  const resumeAttempt = Number.isSafeInteger(Number(source.resumeAttempt)) && source.resumeAttempt >= 0
    ? Math.floor(source.resumeAttempt)
    : 0;
  const limit = Number.isSafeInteger(Number(retryLimit)) && retryLimit >= 0 ? retryLimit : AUTH_RETRY_LIMIT_DEFAULT;
  const credentialInstanceId = trimString(source.credentialInstanceId).slice(0, 128);
  const lastAuthFailureClass = RUN_AUTH_KNOWN_FAILURE_CLASSES.has(trimString(source.lastAuthFailureClass))
    ? trimString(source.lastAuthFailureClass)
    : '';
  return {
    authCredentialVersion: Number.isSafeInteger(Number(source.authCredentialVersion)) && source.authCredentialVersion >= 0
      ? Math.floor(source.authCredentialVersion)
      : null,
    authRetryCount: retryCount,
    authRetryState: state,
    resumeAttempt,
    resumeId: trimString(source.resumeId).slice(0, 256),
    authRetryLimit: limit,
    ...(credentialInstanceId ? { credentialInstanceId } : {}),
    ...(lastAuthFailureClass ? { lastAuthFailureClass } : {}),
  };
}

const AUTH_RECOVERY_STATE_RANK = Object.freeze({
  none: 0,
  auth_retrying: 1,
  auth_recovered: 2,
  auth_retry_exhausted: 3,
  reauth_required: 4,
});

const AUTH_RECOVERY_TERMINAL_STATES = new Set([
  'auth_retry_exhausted',
  'reauth_required',
]);

function compareRecoveryProgress(left, right) {
  const leftVersion = Number.isSafeInteger(left.authCredentialVersion)
    ? left.authCredentialVersion
    : -1;
  const rightVersion = Number.isSafeInteger(right.authCredentialVersion)
    ? right.authCredentialVersion
    : -1;
  for (const [a, b] of [
    [leftVersion, rightVersion],
    [left.authRetryCount, right.authRetryCount],
    [left.resumeAttempt, right.resumeAttempt],
    [AUTH_RECOVERY_STATE_RANK[left.authRetryState] || 0, AUTH_RECOVERY_STATE_RANK[right.authRetryState] || 0],
  ]) {
    if (a !== b) return a > b ? 1 : -1;
  }
  return 0;
}

// Run observers can publish an older snapshot after the sidecar has already
// advanced the recovery state. Merge only monotonic fields and preserve the
// account-chain binding used by the CAS gate.
export function mergeRunAuthRecoveryState(current, proposed, { retryLimit = AUTH_RETRY_LIMIT_DEFAULT } = {}) {
  const left = normalizeRunAuthRecoveryState(current, { retryLimit });
  const right = normalizeRunAuthRecoveryState(proposed, { retryLimit });
  const leftInstance = left.credentialInstanceId || '';
  const rightInstance = right.credentialInstanceId || '';
  const instanceConflict = Boolean(leftInstance && rightInstance && leftInstance !== rightInstance);

  // An instance id is an account-chain binding, not an ordinary progress
  // field. Never let a newer version from another login silently replace the
  // chain already attached to this Run.
  if (instanceConflict) {
    return {
      ...left,
      authRetryLimit: Math.max(left.authRetryLimit, right.authRetryLimit),
      authRetryCount: Math.max(left.authRetryCount, right.authRetryCount),
      resumeAttempt: Math.max(left.resumeAttempt, right.resumeAttempt),
      authRetryState: 'reauth_required',
      lastAuthFailureClass: 'account-mismatch',
    };
  }

  const progress = compareRecoveryProgress(left, right);
  const winner = progress > 0 ? left : (progress < 0 ? right : left);
  const version = Math.max(
    Number.isSafeInteger(left.authCredentialVersion) ? left.authCredentialVersion : -1,
    Number.isSafeInteger(right.authCredentialVersion) ? right.authCredentialVersion : -1,
  );
  const terminalState = AUTH_RECOVERY_TERMINAL_STATES.has(left.authRetryState)
    ? left.authRetryState
    : AUTH_RECOVERY_TERMINAL_STATES.has(right.authRetryState)
      ? right.authRetryState
      : '';
  const state = terminalState || winner.authRetryState;
  return {
    authCredentialVersion: version >= 0 ? version : null,
    authRetryCount: Math.max(left.authRetryCount, right.authRetryCount),
    authRetryState: state,
    resumeAttempt: Math.max(left.resumeAttempt, right.resumeAttempt),
    resumeId: winner.resumeId || left.resumeId || right.resumeId,
    authRetryLimit: Math.max(left.authRetryLimit, right.authRetryLimit),
    ...(leftInstance || rightInstance
      ? { credentialInstanceId: leftInstance || rightInstance }
      : {}),
    ...(winner.lastAuthFailureClass || left.lastAuthFailureClass || right.lastAuthFailureClass
      ? { lastAuthFailureClass: winner.lastAuthFailureClass || left.lastAuthFailureClass || right.lastAuthFailureClass }
      : {}),
  };
}

// Decide the next transition for a failed run. Returns { decision, next }:
//   decision 'retry'    → next.authRetryState = 'auth_retrying'
//   decision 'recovered'→ next.authRetryState = 'auth_recovered'
//   decision 'exhausted'→ next.authRetryState = 'auth_retry_exhausted'
//   decision 'stopped'  → terminal human action (reauth / mismatch)
//   decision 'ignored'  → not an auth failure; leave the run alone
export function planRunAuthRecovery({
  run,
  failureClass = '',
  latestCredential = null,
  sideEffectsConfirmed = false,
  retryLimit = AUTH_RETRY_LIMIT_DEFAULT,
} = {}) {
  const current = normalizeRunAuthRecoveryState(run?.authRecovery, { retryLimit });
  const classification = trimString(failureClass) || classifyRunAuthFailure({
    preview: run?.failureReason || '',
  });

  if (!classification) return { decision: 'ignored', next: current };
  if (RUN_AUTH_STOP_CLASSES.has(classification)) {
    return {
      decision: 'stopped',
      reason: classification,
      next: { ...current, authRetryState: 'reauth_required' },
    };
  }
  if (!RUN_AUTH_FAILURE_CLASSES.has(classification)) {
    return { decision: 'ignored', next: current };
  }

  // A fresh credential must exist and must belong to the same chain identity;
  // otherwise the run cannot self-recover on this device.
  const latestVersion = Number(latestCredential?.credentialVersion);
  const currentInstanceId = trimString(run?.authRecovery?.credentialInstanceId);
  const latestInstanceId = trimString(latestCredential?.credentialInstanceId);
  const sameInstance = !currentInstanceId || latestInstanceId === currentInstanceId;
  if (latestCredential == null
    || !Number.isSafeInteger(latestVersion)
    || latestCredential?.deletedAt
    || !sameInstance) {
    return {
      decision: 'stopped',
      reason: latestCredential?.deletedAt ? 'credential-deleted' : 'credential-unavailable',
      next: { ...current, authRetryState: 'reauth_required' },
    };
  }
  // If the newest credential is the one the run already used, retrying cannot
  // help — the token itself is stale upstream. Only a NEWER version unlocks a retry.
  if (current.authCredentialVersion != null && latestVersion <= current.authCredentialVersion) {
    return {
      decision: 'stopped',
      reason: 'no-newer-credential',
      next: { ...current, authRetryState: 'reauth_required' },
    };
  }

  if (current.authRetryCount >= current.authRetryLimit) {
    return {
      decision: 'exhausted',
      reason: 'auth-retry-limit-reached',
      next: { ...current, authRetryState: 'auth_retry_exhausted' },
    };
  }

  if (sideEffectsConfirmed) {
    // Completed tool side effects block automatic replay entirely.
    return {
      decision: 'stopped',
      reason: 'unconfirmed-side-effects',
      next: { ...current, authRetryState: 'reauth_required' },
    };
  }

  return {
    decision: 'retry',
    reason: 'auth-expired',
    next: {
      ...current,
      authCredentialVersion: latestVersion,
      ...(trimString(latestCredential.credentialInstanceId)
        ? { credentialInstanceId: trimString(latestCredential.credentialInstanceId) }
        : {}),
      authRetryCount: current.authRetryCount + 1,
      authRetryState: 'auth_retrying',
      resumeAttempt: current.resumeAttempt + 1,
      resumeId: trimString(run?.codexThreadId || run?.claudeSessionId || run?.providerResumeId || current.resumeId),
      lastAuthFailureClass: classification,
    },
  };
}

// Mark a resumed run as successfully recovered.
export function markRunAuthRecovered(run, { retryLimit = AUTH_RETRY_LIMIT_DEFAULT } = {}) {
  const current = normalizeRunAuthRecoveryState(run?.authRecovery, { retryLimit });
  return { ...current, authRetryState: 'auth_recovered' };
}

// Convenience alias used by run-record persistence call sites.
export const normalizeRunAuthRecovery = normalizeRunAuthRecoveryState;
