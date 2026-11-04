import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { handleWindowsPrivilegedBrokerRoutes, WINDOWS_BROKER_SERVICE_REQUESTS_PATH as base } from '../chat/windows-privileged-broker.mjs';

const deviceId = 'a'.repeat(64);
const grant = { requestId: 'request', sessionId: 'session', runId: 'run', turnId: 'turn' };
let calls = [];
const brokerClient = {
  pendingServiceControls: async input => { calls.push(['pending', input]); return { items: [], hasMore: false, nextCursor: '' }; },
  status: async id => { calls.push(['status', id]); return { type: 'result', status: 'awaiting_device', serviceControl: grant }; },
  approveServiceControl: async input => { calls.push(['approve', input]); return { type: 'result', requestId: input.requestId, status: 'executing' }; },
  denyServiceControl: async input => { calls.push(['deny', input]); return { type: 'result', requestId: input.requestId, status: 'denied' }; },
};
async function call(method, pathname, { query = '', body, role = 'owner', riskMode = 'recommended', sessionAccess = true, runActive = true } = {}) {
  const req = new PassThrough();
  req.method = method; req.url = pathname + query; req.headers = {};
  queueMicrotask(() => req.end(body === undefined ? undefined : JSON.stringify(body)));
  const res = Object.assign(new EventEmitter(), { setHeader() {} });
  let result;
  const handled = await handleWindowsPrivilegedBrokerRoutes({
    req, res, pathname, authSession: { role }, brokerClient,
    requireSessionAccess: async () => { if (!sessionAccess) result = { status: 403 }; return sessionAccess; },
    getSession: async () => ({ riskMode }), resolveSessionRiskMode: s => s.riskMode,
    authorizeServiceApproval: async actual => runActive && actual === grant,
    writeJson: (_res, status, payload) => { result = { status, payload }; },
  });
  assert.equal(handled, true);
  return result;
}
const decisionPath = `${base}/request/decision`;
const body = { deviceId, choice: 'approve', deviceSignature: 'eA==' };
assert.equal((await call('GET', `${base}/pending`, { query: `?deviceId=${deviceId}` })).payload.type, 'service_pending');
assert.equal((await call('GET', `${base}/pending`, { query: `?deviceId=${deviceId}&deviceId=${deviceId}` })).status, 400);
const originalPending = brokerClient.pendingServiceControls;
brokerClient.pendingServiceControls = async () => { throw Object.assign(new Error('busy'), { code: 'RATE_LIMITED' }); };
const limited = await call('GET', `${base}/pending`, { query: `?deviceId=${deviceId}` });
assert.equal(limited.status, 429);
assert.equal(limited.payload.code, 'RATE_LIMITED');
brokerClient.pendingServiceControls = originalPending;
calls = [];
assert.equal((await call('POST', decisionPath, { body, role: 'viewer' })).status, 403);
assert.equal(calls.length, 0);
assert.equal((await call('POST', decisionPath, { body, sessionAccess: false })).status, 403);
assert.equal(calls.some(([name]) => name === 'approve'), false);
calls = [];
assert.equal((await call('POST', decisionPath, { body, runActive: false })).status, 409);
assert.equal(calls.some(([name]) => name === 'approve'), false);
for (const riskMode of ['full-auto', 'conservative-auto']) {
  calls = [];
  assert.equal((await call('POST', decisionPath, { body, riskMode })).status, 403);
  assert.equal(calls.some(([name]) => name === 'approve'), false);
  assert.equal((await call('POST', decisionPath, { body: { ...body, choice: 'deny' }, riskMode })).payload.status, 'denied');
}
calls = [];
assert.equal((await call('POST', decisionPath, { body })).payload.status, 'executing');
assert.deepEqual(calls.map(([name]) => name), ['status', 'approve']);
assert.equal((await call('POST', decisionPath, { body: { ...body, grant } })).status, 400);
console.log('windows-service-approval-routes: ok');
