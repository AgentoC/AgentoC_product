import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createTemporaryControlCarrierIngress } from '../chat/temporary-control-carrier-ingress.mjs';
import { createConnectivityPolicyEngine } from '../lib/connectivity-policy-engine.mjs';
import { temporaryControlCarrierRoute } from '../lib/temporary-control-routes.mjs';
import { TEMPORARY_CONTROL_CAPABILITIES, TEMPORARY_CONTROL_SESSION_SCOPE } from '../lib/temporary-control-policy.mjs';

const instanceId = 'inst_abcdefghijklmnopqrstuvwx';
const principal = (overrides = {}) => ({
  role: 'temporary', principalKind: 'temporary_device', sessionScope: TEMPORARY_CONTROL_SESSION_SCOPE,
  capabilities: [...TEMPORARY_CONTROL_CAPABILITIES], instanceId,
  grantId: 'rtg_abcdefghijklmnopqrstuvwx', expiry: Date.now() + 60_000, ...overrides,
});

function request(method, path) {
  const req = Readable.from([]);
  req.method = method;
  req.url = `/api/temporary-control/v1/instances/${instanceId}${path}`;
  req.headers = {};
  return req;
}

function response() {
  return { headersSent: false, destroyed: false, writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(body) { this.body = body; } };
}

test('carrier forwards an authenticated named route as a temporary principal without forwarding the P2P URL', async () => {
  let revalidated = 0;
  const ingress = createTemporaryControlCarrierIngress({
    authenticate: async () => principal(),
    revalidate: async (value) => { assert.equal(value.role, 'temporary'); revalidated += 1; },
    dispatch: async (req) => {
      assert.equal(req.url, '/api/native-providers/provider-1/quota/refresh');
      assert.equal(req._temporaryControlOperation, 'provider.quota.refresh');
      assert.equal(req._bearerAuthSession.role, 'owner', 'legacy guards receive the compatibility role');
      assert.equal(req._bearerAuthSession.principalKind, 'temporary_device');
      assert.equal(req._bearerAuthSession.temporaryControlOriginalRole, 'temporary');
    },
  });
  await ingress(request('POST', '/providers/provider-1/quota/refresh'), response());
  assert.equal(revalidated, 1);
});

test('carrier rejects unmapped routes and malformed or partial principals before dispatch', async () => {
  let dispatched = 0;
  const rejected = createTemporaryControlCarrierIngress({
    authenticate: async () => principal({ capabilities: ['session.read'] }),
    dispatch: async () => { dispatched += 1; },
  });
  const denied = response();
  await rejected(request('POST', '/runs/run-1/privileged-batches/batch-1/categories/delete'), denied);
  assert.equal(denied.status, 403); assert.equal(dispatched, 0);

  const unknown = response();
  await rejected(request('POST', '/native-admin/restart'), unknown);
  assert.equal(unknown.status, 403); assert.equal(dispatched, 0);
});

test('carrier preserves permitted queries and rejects a different grant or device', async () => {
  const expiry = Date.now() + 60_000;
  const device = { instanceId, grantId: 'grant-1', deviceId: 'device-1', accessExpiresAt: expiry };
  let current = principal({ ...device, expiry });
  let dispatched = 0;
  const ingress = createTemporaryControlCarrierIngress({ carrierDevice: device, authenticate: async () => current,
    dispatch: async (req) => { dispatched++; assert.equal(req.url, '/api/sessions/session-1?view=summary'); } });
  await ingress(request('GET', '/sessions/session-1?view=summary'), response());
  current = { ...current, grantId: 'grant-2' };
  const denied = response();
  await ingress(request('GET', '/sessions/session-1?view=summary'), denied);
  assert.equal(denied.status, 403);
  assert.equal(dispatched, 1);
});

test('the P2P policy admits only v2 control routes when its dedicated carrier is active', () => {
  const instanceId = 'inst_abcdefghijklmnopqrstuvwxyz012345';
  const policy = createConnectivityPolicyEngine({ temporaryDevice: { instanceId }, temporaryIngressReady: true,
    temporaryRoute: temporaryControlCarrierRoute });
  const allowed = policy.decide({ method: 'POST',
    url: `/api/temporary-control/v1/instances/${instanceId}/sessions`, headers: {} });
  assert.deepEqual(allowed, { kind: 'temporary_authenticated', scope: 'session.create', principalKind: 'temporary_device' });
  for (const url of [
    `/api/temporary/v1/instances/${instanceId}/sessions`,
    `/api/temporary-control/v1/instances/${instanceId}/sessions?x=1`,
    '/api/sessions',
  ]) assert.equal(policy.decide({ method: 'POST', url, headers: {} }).kind, 'blocked');
});
