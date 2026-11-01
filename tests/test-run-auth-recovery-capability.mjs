#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  RUN_AUTH_RECOVERY_ENDPOINT,
  RUN_AUTH_RECOVERY_OPERATION,
  RUN_AUTH_RECOVERY_RUN_ID_HEADER,
  RUN_AUTH_RECOVERY_SESSION_ID_HEADER,
  RUN_AUTH_RECOVERY_TOKEN_HEADER,
  RUN_AUTH_RECOVERY_TURN_ID_HEADER,
  createRunAuthRecoveryAuthenticator,
  createRunAuthRecoveryCapability,
  hashRunAuthRecoveryToken,
  isStrictLoopbackRequest,
} from '../chat/run-auth-recovery-capability.mjs';

const secret = 'capability-test-secret';
const issuedAt = Date.parse('2026-08-27T00:00:00.000Z');
const capability = createRunAuthRecoveryCapability({
  runId: 'run_capability_1',
  sessionId: 'session_capability_1',
  turnId: 'turn_capability_1',
  now: issuedAt,
  ttlMs: 60_000,
  secret,
});

assert.ok(capability?.token);
assert.equal(capability.endpoint, RUN_AUTH_RECOVERY_ENDPOINT);
assert.equal(capability.tokenHash, hashRunAuthRecoveryToken(capability.token));
assert.equal(capability.runId, 'run_capability_1');
assert.equal(capability.sessionId, 'session_capability_1');
assert.equal(capability.turnId, 'turn_capability_1');
assert.ok(capability.expiresAt);

const run = {
  id: capability.runId,
  sessionId: capability.sessionId,
  state: 'failed',
  finalizedAt: null,
};
const { token: _token, ...manifestChannel } = capability;
const manifest = {
  id: capability.runId,
  sessionId: capability.sessionId,
  requestId: capability.turnId,
  options: {
    runAuthRecoveryChannel: manifestChannel,
  },
};

function request(overrides = {}) {
  return {
    url: RUN_AUTH_RECOVERY_ENDPOINT,
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      [RUN_AUTH_RECOVERY_TOKEN_HEADER]: capability.token,
      [RUN_AUTH_RECOVERY_RUN_ID_HEADER]: capability.runId,
      [RUN_AUTH_RECOVERY_SESSION_ID_HEADER]: capability.sessionId,
      [RUN_AUTH_RECOVERY_TURN_ID_HEADER]: capability.turnId,
    },
    ...overrides,
  };
}

assert.equal(isStrictLoopbackRequest(request()), true);
assert.equal(isStrictLoopbackRequest({ socket: { remoteAddress: '::1' } }), true);
assert.equal(isStrictLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
assert.equal(isStrictLoopbackRequest({ socket: { remoteAddress: '192.0.2.10' } }), false);
assert.equal(isStrictLoopbackRequest({ socket: {} }), false, 'missing remote address must fail closed');
assert.equal(isStrictLoopbackRequest({}), false, 'missing socket must fail closed');

let nowCalls = 0;
const authenticate = createRunAuthRecoveryAuthenticator({
  secret,
  now: () => {
    nowCalls += 1;
    return issuedAt + 10_000;
  },
  getRunImpl: async (runId) => (runId === run.id ? run : null),
  getRunManifestImpl: async (runId) => (runId === manifest.id ? manifest : null),
});

const principal = await authenticate(request());
assert.equal(nowCalls, 1, 'authenticator must evaluate the clock once');
assert.equal(principal.capabilityOperation, RUN_AUTH_RECOVERY_OPERATION);
assert.equal(principal.runId, run.id);
assert.equal(principal.sessionId, run.sessionId);
assert.equal(principal.turnId, manifest.requestId);

const tamperedToken = `${capability.token.slice(0, -1)}${capability.token.endsWith('A') ? 'B' : 'A'}`;
assert.equal(await authenticate(request({ headers: { ...request().headers, [RUN_AUTH_RECOVERY_TOKEN_HEADER]: tamperedToken } })), null);
assert.equal(await authenticate(request({ headers: { ...request().headers, [RUN_AUTH_RECOVERY_RUN_ID_HEADER]: 'run_other' } })), null);
assert.equal(await authenticate(request({ headers: { ...request().headers, [RUN_AUTH_RECOVERY_SESSION_ID_HEADER]: 'session_other' } })), null);
assert.equal(await authenticate(request({ headers: { ...request().headers, [RUN_AUTH_RECOVERY_TURN_ID_HEADER]: 'turn_other' } })), null);
assert.equal(await authenticate(request({ socket: { remoteAddress: '203.0.113.10' } })), null);
assert.equal(await authenticate(request({ socket: {} })), null);
assert.equal(await authenticate(request({ method: 'GET' })), null);
assert.equal(await authenticate(request({ url: `${RUN_AUTH_RECOVERY_ENDPOINT}/extra` })), null);

const manifestWithWrongHash = {
  ...manifest,
  options: {
    ...manifest.options,
    runAuthRecoveryChannel: {
      ...manifestChannel,
      tokenHash: hashRunAuthRecoveryToken('another-token'),
    },
  },
};
const wrongHashAuth = createRunAuthRecoveryAuthenticator({
  secret,
  now: () => issuedAt + 10_000,
  getRunImpl: async () => run,
  getRunManifestImpl: async () => manifestWithWrongHash,
});
assert.equal(await wrongHashAuth(request()), null, 'manifest token hash binds the capability');

const expiredAuth = createRunAuthRecoveryAuthenticator({
  secret,
  now: () => issuedAt + 60_000,
  getRunImpl: async () => run,
  getRunManifestImpl: async () => manifest,
});
assert.equal(await expiredAuth(request()), null, 'expired capability must be rejected');

const finalizedAuth = createRunAuthRecoveryAuthenticator({
  secret,
  now: () => issuedAt + 10_000,
  getRunImpl: async () => ({ ...run, state: 'completed', finalizedAt: new Date(issuedAt).toISOString() }),
  getRunManifestImpl: async () => manifest,
});
assert.equal(await finalizedAuth(request()), null, 'finalized Run must not authenticate recovery');

console.log('test-run-auth-recovery-capability: signature, TTL, binding, and local-only gate OK');
