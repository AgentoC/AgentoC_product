#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  RUN_AUTH_RECOVERY_ENDPOINT,
  RUN_AUTH_RECOVERY_RUN_ID_HEADER,
  RUN_AUTH_RECOVERY_SESSION_ID_HEADER,
  RUN_AUTH_RECOVERY_TOKEN_HEADER,
  RUN_AUTH_RECOVERY_TURN_ID_HEADER,
  createRunAuthRecoveryAuthenticator,
  createRunAuthRecoveryCapability,
} from '../chat/run-auth-recovery-capability.mjs';
import { handleRunAuthRecoveryInternalRoutes } from '../chat/router-run-auth-recovery-routes.mjs';

const secret = 'route-test-secret';
const capability = createRunAuthRecoveryCapability({
  runId: 'run_route_1',
  sessionId: 'session_route_1',
  turnId: 'turn_route_1',
  now: Date.parse('2026-08-27T00:00:00.000Z'),
  secret,
});
const run = { id: capability.runId, sessionId: capability.sessionId, state: 'failed' };
const { token: _token, ...manifestChannel } = capability;
const manifest = {
  id: capability.runId,
  sessionId: capability.sessionId,
  requestId: capability.turnId,
  options: { runAuthRecoveryChannel: manifestChannel },
};
const authenticate = createRunAuthRecoveryAuthenticator({
  secret,
  now: () => Date.parse('2026-08-27T00:01:00.000Z'),
  getRunImpl: async () => run,
  getRunManifestImpl: async () => manifest,
});

function makeRequest(body = '', overrides = {}) {
  const request = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      [RUN_AUTH_RECOVERY_TOKEN_HEADER]: capability.token,
      [RUN_AUTH_RECOVERY_RUN_ID_HEADER]: capability.runId,
      [RUN_AUTH_RECOVERY_SESSION_ID_HEADER]: capability.sessionId,
      [RUN_AUTH_RECOVERY_TURN_ID_HEADER]: capability.turnId,
    },
    on(event, handler) {
      if (event === 'data' && body) queueMicrotask(() => handler(Buffer.from(body)));
      if (event === 'end') queueMicrotask(() => handler());
      return this;
    },
    ...overrides,
  };
  return request;
}

function response() {
  return { status: 0, payload: null };
}

async function invoke({ body = '', requestOverrides = {}, recover = async () => ({ ok: true, retry: true, status: 'retrying' }) } = {}) {
  const result = response();
  const handled = await handleRunAuthRecoveryInternalRoutes({
    req: makeRequest(body, requestOverrides),
    res: result,
    pathname: RUN_AUTH_RECOVERY_ENDPOINT,
    writeJson: (_res, status, payload) => {
      result.status = status;
      result.payload = payload;
    },
    authenticate,
    recoverRunAuthFailure: recover,
  });
  return { handled, result };
}

const unrelated = await handleRunAuthRecoveryInternalRoutes({
  req: makeRequest(),
  res: response(),
  pathname: '/api/other',
  writeJson: () => assert.fail('unrelated route must not write'),
  authenticate,
  recoverRunAuthFailure: async () => assert.fail('unrelated route must not recover'),
});
assert.equal(unrelated, false);

let result = await invoke({ requestOverrides: { method: 'GET' } });
assert.equal(result.handled, true);
assert.equal(result.result.status, 405);
assert.equal(result.result.payload.code, 'RUN_AUTH_RECOVERY_METHOD_NOT_ALLOWED');

result = await invoke({ requestOverrides: { socket: { remoteAddress: '192.0.2.1' } } });
assert.equal(result.result.status, 403);
assert.equal(result.result.payload.code, 'RUN_AUTH_RECOVERY_LOCAL_ONLY');

result = await invoke({ requestOverrides: { headers: { ...makeRequest().headers, [RUN_AUTH_RECOVERY_TOKEN_HEADER]: 'bad' } } });
assert.equal(result.result.status, 401);
assert.equal(result.result.payload.code, 'RUN_AUTH_RECOVERY_CAPABILITY_INVALID');

result = await invoke({ body: '{not-json' });
assert.equal(result.result.status, 400);
assert.equal(result.result.payload.code, 'RUN_AUTH_RECOVERY_REQUEST_INVALID');

result = await invoke({ body: JSON.stringify({ failureClass: 'network-error', failureAttempt: 0 }) });
assert.equal(result.result.status, 400);
assert.equal(result.result.payload.code, 'RUN_AUTH_RECOVERY_REQUEST_INVALID');

result = await invoke({ body: JSON.stringify({ failureClass: 'auth-expired', failureAttempt: -1 }) });
assert.equal(result.result.status, 400);

result = await invoke({ body: JSON.stringify({ failureClass: 'auth-expired', failureAttempt: 0, requesterProcessId: -1 }) });
assert.equal(result.result.status, 400);

let received = null;
result = await invoke({
  body: JSON.stringify({ failureClass: 'auth-expired', failureAttempt: 1, sideEffectsConfirmed: false, requesterProcessId: 43210 }),
  recover: async (input) => {
    received = input;
    return { ok: true, retry: true, status: 'retrying', queued: false };
  },
});
assert.equal(result.result.status, 202);
assert.equal(result.result.payload.status, 'retrying');
assert.equal(received.runId, capability.runId);
assert.equal(received.sessionId, capability.sessionId);
assert.equal(received.turnId, capability.turnId);
assert.equal(received.failureClass, 'auth-expired');
assert.equal(received.failureAttempt, 1);
assert.equal(received.sideEffectsConfirmed, false);
assert.equal(received.requesterProcessId, 43210);

result = await invoke({
  body: JSON.stringify({ failureClass: 'auth-expired', failureAttempt: 0, sideEffectsConfirmed: true }),
  recover: async () => ({ ok: false, retry: false, status: 'stopped', reason: 'unconfirmed-side-effects' }),
});
assert.equal(result.result.status, 200);
assert.equal(result.result.payload.reason, 'unconfirmed-side-effects');

console.log('test-router-run-auth-recovery-routes: method, capability, body, and recovery dispatch gates OK');
