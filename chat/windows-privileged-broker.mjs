import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { readBody } from '../lib/utils.mjs';
import {
  currentWindowsBrokerApprovalRevision,
  publishWindowsBrokerApprovalInvalidation,
  waitForWindowsBrokerApprovalChange,
} from './windows-broker-approval-invalidation.mjs';

export const WINDOWS_BROKER_PROTOCOL_VERSION = 2;
export const WINDOWS_BROKER_MAX_FRAME_BYTES = 64 * 1024;
export const WINDOWS_BROKER_TARGET_ID = 'AgentoC-Broker-QA-Target';
export const WINDOWS_BROKER_REQUESTS_PATH = '/api/windows-privileged-broker/requests';
export const WINDOWS_BROKER_ENROLLMENTS_PATH = '/api/windows-privileged-broker/enrollments';

// The first Broker operation is never predelegated. Autonomous profiles may
// propose it, but an enrolled device must sign every exact restart challenge.
// Conservative-auto denies side-effecting Broker operations entirely.
export function resolveWindowsBrokerProfileDecision(riskMode, platform = process.platform) {
  if (platform !== 'win32') return { decision: 'deny', code: 'BROKER_PLATFORM_UNSUPPORTED' };
  if (riskMode === 'conservative-auto') return { decision: 'deny', code: 'BROKER_PERMISSION_PROFILE_DENIED' };
  if (['full-auto', 'recommended', 'safe'].includes(riskMode)) {
    return { decision: 'require_device', code: 'BROKER_DEVICE_APPROVAL_REQUIRED' };
  }
  return { decision: 'deny', code: 'BROKER_PERMISSION_PROFILE_UNAVAILABLE' };
}

const PIPE_PATHS = Object.freeze({
  health: String.raw`\\.\pipe\AgentoC.PrivilegedBroker.Health.v2`,
  request: String.raw`\\.\pipe\AgentoC.PrivilegedBroker.Request.v2`,
});
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DEVICE_ID_PATTERN = /^[a-f0-9]{64}$/;
const SIGNATURE_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE_PATH = WINDOWS_BROKER_REQUESTS_PATH;

function brokerError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateRequest(request) {
  if (!isRecord(request) || request.version !== WINDOWS_BROKER_PROTOCOL_VERSION) {
    throw brokerError('BROKER_REQUEST_INVALID');
  }
  if (request.type === 'health') {
    if (!hasOnlyKeys(request, ['version', 'type'])) throw brokerError('BROKER_REQUEST_INVALID');
    return;
  }
  if (request.type === 'status') {
    if (!hasOnlyKeys(request, ['version', 'type', 'requestId']) || !validId(request.requestId)) {
      throw brokerError('BROKER_REQUEST_INVALID');
    }
    return;
  }
  if (request.type === 'pending') {
    if (!hasOnlyKeys(request, ['version', 'type', 'deviceId', 'cursor']) ||
        typeof request.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(request.deviceId) ||
        (request.cursor !== undefined && !validId(request.cursor))) {
      throw brokerError('BROKER_REQUEST_INVALID');
    }
    return;
  }
  if (request.type === 'enrollment.pending') {
    if (!hasOnlyKeys(request, ['version', 'type', 'deviceId']) ||
        typeof request.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(request.deviceId)) {
      throw brokerError('BROKER_REQUEST_INVALID');
    }
    return;
  }
  if (request.type === 'enrollment.complete') {
    if (!hasOnlyKeys(request, ['version', 'type', 'enrollmentId', 'verificationCode', 'signature']) ||
        !validId(request.enrollmentId) || !/^[0-9]{8}$/.test(request.verificationCode) ||
        typeof request.signature !== 'string' || request.signature.length === 0 || request.signature.length > 1024 ||
        !SIGNATURE_PATTERN.test(request.signature)) {
      throw brokerError('BROKER_REQUEST_INVALID');
    }
    return;
  }
  if (request.type === 'propose') {
    const keys = ['version', 'type', 'requestId', 'sessionId', 'runId', 'turnId', 'actionId', 'operation', 'targetId'];
    if (!hasOnlyKeys(request, keys) || !keys.slice(2, 7).every((key) => validId(request[key])) ||
        request.operation !== 'service.restart' || request.targetId !== WINDOWS_BROKER_TARGET_ID) {
      throw brokerError('BROKER_REQUEST_INVALID');
    }
    return;
  }
  if (request.type === 'decision') {
    if (!hasOnlyKeys(request, ['version', 'type', 'requestId', 'deviceId', 'choice', 'signature']) ||
        !validId(request.requestId) || typeof request.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(request.deviceId) ||
        !['approve', 'deny'].includes(request.choice) || typeof request.signature !== 'string' ||
        request.signature.length === 0 || request.signature.length > 1024 || !SIGNATURE_PATTERN.test(request.signature)) {
      throw brokerError('BROKER_REQUEST_INVALID');
    }
    return;
  }
  throw brokerError('BROKER_REQUEST_INVALID');
}

function validateResponse(response) {
  if (!isRecord(response) || response.version !== WINDOWS_BROKER_PROTOCOL_VERSION ||
      typeof response.type !== 'string' || !/^[a-z_]{1,48}$/.test(response.type)) {
    throw brokerError('BROKER_RESPONSE_INVALID');
  }
  return response;
}

function encodeFrame(request) {
  validateRequest(request);
  const payload = Buffer.from(JSON.stringify(request), 'utf8');
  if (payload.length === 0 || payload.length > WINDOWS_BROKER_MAX_FRAME_BYTES) {
    throw brokerError('BROKER_REQUEST_TOO_LARGE');
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function readResponseFrame(buffer, expectedLength) {
  let frameLength = expectedLength;
  if (frameLength === null && buffer.length >= 4) {
    frameLength = buffer.readUInt32LE(0);
    if (frameLength === 0 || frameLength > WINDOWS_BROKER_MAX_FRAME_BYTES) {
      throw brokerError('BROKER_RESPONSE_INVALID');
    }
  }
  if (frameLength === null || buffer.length < frameLength + 4) return { frameLength, response: null };
  if (buffer.length !== frameLength + 4) throw brokerError('BROKER_RESPONSE_INVALID');
  let response;
  try {
    response = JSON.parse(buffer.subarray(4).toString('utf8'));
  } catch {
    throw brokerError('BROKER_RESPONSE_INVALID');
  }
  return { frameLength, response: validateResponse(response) };
}

function exchangePipeFrame({ connect, pipePath, request, timeoutMs }) {
  const frame = encodeFrame(request);
  return new Promise((resolve, reject) => {
    let socket;
    let buffer = Buffer.alloc(0);
    let expectedLength = null;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        socket?.destroy();
        reject(error);
      } else {
        socket?.destroy();
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(brokerError('BROKER_PIPE_TIMEOUT')), timeoutMs);
    timer.unref?.();
    try {
      socket = connect({ path: pipePath, allowHalfOpen: true });
    } catch {
      finish(brokerError('BROKER_PIPE_UNAVAILABLE'));
      return;
    }
    socket.once('connect', () => {
      try {
        // Half-close the request direction. The Broker reads exactly one frame
        // and waits for request EOF before closing its response stream.
        socket.end(frame);
      } catch {
        finish(brokerError('BROKER_PIPE_UNAVAILABLE'));
      }
    });
    socket.on('data', (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const parsed = readResponseFrame(buffer, expectedLength);
        expectedLength = parsed.frameLength;
        if (parsed.response) finish(null, parsed.response);
      } catch (error) {
        finish(error?.code ? error : brokerError('BROKER_RESPONSE_INVALID'));
      }
    });
    socket.once('error', () => finish(brokerError('BROKER_PIPE_UNAVAILABLE')));
    socket.once('close', () => {
      if (!settled) finish(brokerError('BROKER_PIPE_CLOSED'));
    });
  });
}

function exchangeViaServiceHost({ request, pipe, timeoutMs, serviceHostPath }) {
  const requestFrame = encodeFrame(request);
  const pipeArgument = pipe === 'health' ? 'health' : 'request';
  const executable = serviceHostPath || path.resolve(path.dirname(process.execPath), '..', 'AgentoC.ServiceHost.exe');
  return new Promise((resolve, reject) => {
    let child;
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child?.kill();
        reject(error);
      } else {
        resolve(response);
      }
    };
    const timer = setTimeout(() => finish(brokerError('BROKER_PIPE_TIMEOUT')), timeoutMs + 5000);
    timer.unref?.();
    try {
      child = spawn(executable, ['--broker-pipe', pipeArgument], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      finish(brokerError('BROKER_PIPE_UNAVAILABLE'));
      return;
    }
    child.once('error', () => finish(brokerError('BROKER_PIPE_UNAVAILABLE')));
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > WINDOWS_BROKER_MAX_FRAME_BYTES + 4) {
        finish(brokerError('BROKER_RESPONSE_INVALID'));
      }
    });
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(brokerError('BROKER_PIPE_UNAVAILABLE'));
        return;
      }
      try {
        const parsed = readResponseFrame(buffer, null);
        if (!parsed.response) throw brokerError('BROKER_RESPONSE_INVALID');
        finish(null, parsed.response);
      } catch (error) {
        finish(error?.code ? error : brokerError('BROKER_RESPONSE_INVALID'));
      }
    });
    child.stdin.once('error', () => finish(brokerError('BROKER_PIPE_UNAVAILABLE')));
    child.stdin.end(requestFrame);
  });
}

export function createWindowsPrivilegedBrokerClient({
  connect = createConnection,
  platform = process.platform,
  timeoutMs = 5000,
  pipeExchange,
  serviceHostPath,
} = {}) {
  const useServiceHostBridge = platform === 'win32' && connect === createConnection;
  const rpc = (pipe, request) => {
    if (platform !== 'win32') return Promise.reject(brokerError('BROKER_PLATFORM_UNSUPPORTED'));
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
      return Promise.reject(brokerError('BROKER_CLIENT_CONFIGURATION_INVALID'));
    }
    try {
      if (pipeExchange) {
        encodeFrame(request);
        return pipeExchange({ pipe, request, timeoutMs });
      }
      if (useServiceHostBridge) return exchangeViaServiceHost({ request, pipe, timeoutMs, serviceHostPath });
      return exchangePipeFrame({ connect, pipePath: PIPE_PATHS[pipe], request, timeoutMs });
    } catch (error) {
      return Promise.reject(error?.code ? error : brokerError('BROKER_REQUEST_INVALID'));
    }
  };
  return Object.freeze({
    health: () => rpc('health', { version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'health' }),
    status: (requestId) => rpc('request', {
      version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'status', requestId,
    }),
    pending: ({ deviceId, cursor }) => rpc('request', {
      version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'pending', deviceId,
      ...(cursor ? { cursor } : {}),
    }),
    pendingEnrollment: ({ deviceId }) => rpc('request', {
      version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'enrollment.pending', deviceId,
    }),
    completeEnrollment: ({ enrollmentId, verificationCode, signature }) => rpc('request', {
      version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'enrollment.complete',
      enrollmentId, verificationCode, signature,
    }),
    propose: ({ requestId, sessionId, runId, turnId, actionId, operation, targetId }) => rpc('request', {
      version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'propose',
      requestId, sessionId, runId, turnId, actionId, operation, targetId,
    }),
    decision: ({ requestId, deviceId, choice, signature }) => rpc('request', {
      version: WINDOWS_BROKER_PROTOCOL_VERSION, type: 'decision',
      requestId, deviceId, choice, signature,
    }),
  });
}

const defaultWindowsBrokerClient = createWindowsPrivilegedBrokerClient();

function brokerHttpStatus(response) {
  if (response?.type !== 'error') return 200;
  if (response.code === 'REQUEST_INVALID' || response.code === 'PROTOCOL_UNSUPPORTED') return 400;
  if (response.code === 'REQUEST_ID_CONFLICT') return 409;
  if (response.code === 'RATE_LIMITED') return 429;
  if (response.code === 'ENROLLMENT_NOT_FOUND') return 404;
  if (response.code === 'ENROLLMENT_EXPIRED') return 410;
  if (response.code === 'ENROLLMENT_CODE_MISMATCH' || response.code === 'ENROLLMENT_SIGNATURE_INVALID') return 403;
  return 503;
}

function brokerHttpErrorStatus(error) {
  if (error?.code === 'BROKER_REQUEST_INVALID' || error?.code === 'BROKER_REQUEST_TOO_LARGE') return 400;
  if (error?.code === 'BODY_TOO_LARGE') return 413;
  if (error?.code === 'BROKER_PLATFORM_UNSUPPORTED') return 501;
  return 503;
}

function decodeRequestId(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return '';
  }
  return validId(decoded) ? decoded : '';
}

async function readJsonBody(req) {
  const text = await readBody(req, 8192);
  let value;
  try {
    value = JSON.parse(text || '{}');
  } catch {
    throw brokerError('BROKER_REQUEST_INVALID');
  }
  if (!isRecord(value)) throw brokerError('BROKER_REQUEST_INVALID');
  return value;
}

function isOwner(authSession) {
  return authSession?.role === 'owner' && authSession?.principalKind !== 'run_capability';
}

function writeUnavailable(writeJson, res, error) {
  const status = brokerHttpErrorStatus(error);
  const code = status === 400 ? 'BROKER_REQUEST_INVALID'
    : status === 413 ? 'BROKER_REQUEST_TOO_LARGE'
      : status === 501 ? 'BROKER_PLATFORM_UNSUPPORTED'
        : error?.code === 'BROKER_PIPE_TIMEOUT' ? 'BROKER_PIPE_TIMEOUT'
          : 'BROKER_UNAVAILABLE';
  writeJson(res, status, { code, error: status === 501 ? 'Windows Broker is available only on Windows' : 'Windows Broker is unavailable' });
}

export async function handleWindowsPrivilegedBrokerRoutes({
  req,
  res,
  pathname,
  authSession,
  requireSessionAccess,
  getSession,
  resolveSessionRiskMode,
  writeJson,
  reauthorizePending,
  brokerClient = defaultWindowsBrokerClient,
}) {
  const pendingPath = pathname === `${BASE_PATH}/pending`;
  const pendingEnrollmentPath = pathname === `${WINDOWS_BROKER_ENROLLMENTS_PATH}/pending`;
  const statusMatch = pendingPath ? null : pathname.match(/^\/api\/windows-privileged-broker\/requests\/([^/]+)$/);
  const decisionMatch = pathname.match(/^\/api\/windows-privileged-broker\/requests\/([^/]+)\/decision$/);
  const completeEnrollmentMatch = pathname.match(/^\/api\/windows-privileged-broker\/enrollments\/([^/]+)\/complete$/);
  if (pathname !== BASE_PATH && !statusMatch && !decisionMatch && !pendingPath && !pendingEnrollmentPath && !completeEnrollmentMatch) return false;
  res.setHeader?.('Cache-Control', 'private, no-store');
  if (!isOwner(authSession)) {
    req.resume?.();
    writeJson(res, 403, { code: 'OWNER_ACCESS_REQUIRED', error: 'Owner access required' });
    return true;
  }

  if (pathname === BASE_PATH && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const allowed = ['requestId', 'sessionId', 'runId', 'turnId', 'actionId', 'operation', 'targetId'];
      if (!hasOnlyKeys(body, allowed) || !allowed.every((key) => validId(body[key])) ||
          body.operation !== 'service.restart' || body.targetId !== WINDOWS_BROKER_TARGET_ID) {
        throw brokerError('BROKER_REQUEST_INVALID');
      }
      if (requireSessionAccess && !await requireSessionAccess(res, authSession, body.sessionId)) return true;
      if (typeof getSession !== 'function' || typeof resolveSessionRiskMode !== 'function') {
        writeJson(res, 503, { code: 'BROKER_SESSION_POLICY_UNAVAILABLE', error: 'Broker session policy is unavailable' });
        return true;
      }
      const session = await getSession(body.sessionId);
      if (!session) {
        writeJson(res, 404, { code: 'BROKER_SESSION_NOT_FOUND', error: 'Broker session was not found' });
        return true;
      }
      const profile = resolveWindowsBrokerProfileDecision(resolveSessionRiskMode(session));
      if (profile.decision !== 'require_device') {
        writeJson(res, 403, { code: profile.code, error: 'Broker policy denied this operation' });
        return true;
      }
      const response = await brokerClient.propose(body);
      publishWindowsBrokerApprovalInvalidation(response, { action: 'propose', requestId: body.requestId });
      writeJson(res, brokerHttpStatus(response), response);
    } catch (error) {
      writeUnavailable(writeJson, res, error);
    }
    return true;
  }

  if (statusMatch && req.method === 'GET') {
    const requestId = decodeRequestId(statusMatch[1]);
    if (!requestId) {
      writeJson(res, 400, { code: 'BROKER_REQUEST_INVALID', error: 'Invalid Broker request ID' });
      return true;
    }
    try {
      const response = await brokerClient.status(requestId);
      publishWindowsBrokerApprovalInvalidation(response, { action: 'status', requestId });
      writeJson(res, brokerHttpStatus(response), response);
    } catch (error) {
      writeUnavailable(writeJson, res, error);
    }
    return true;
  }

  if (decisionMatch && req.method === 'POST') {
    const requestId = decodeRequestId(decisionMatch[1]);
    if (!requestId) {
      writeJson(res, 400, { code: 'BROKER_REQUEST_INVALID', error: 'Invalid Broker request ID' });
      return true;
    }
    try {
      const body = await readJsonBody(req);
      if (!hasOnlyKeys(body, ['deviceId', 'choice', 'signature'])) throw brokerError('BROKER_REQUEST_INVALID');
      if (typeof getSession !== 'function' || typeof resolveSessionRiskMode !== 'function') {
        writeJson(res, 503, { code: 'BROKER_SESSION_POLICY_UNAVAILABLE', error: 'Broker session policy is unavailable' });
        return true;
      }
      const current = await brokerClient.status(requestId);
      const sessionId = trimString(current?.challenge?.sessionId);
      if (current?.type === 'error') {
        writeJson(res, brokerHttpStatus(current), current);
        return true;
      }
      if (current?.type !== 'result' || current.status !== 'awaiting_device' || !validId(sessionId)) {
        writeJson(res, 409, { code: 'BROKER_CHALLENGE_UNAVAILABLE', error: 'No pending Broker challenge is available' });
        return true;
      }
      const session = await getSession(sessionId);
      if (!session) {
        writeJson(res, 403, { code: 'BROKER_PERMISSION_PROFILE_DENIED', error: 'Broker policy denied this operation' });
        return true;
      }
      const profile = resolveWindowsBrokerProfileDecision(resolveSessionRiskMode(session));
      if (profile.decision !== 'require_device') {
        writeJson(res, 403, { code: profile.code, error: 'Broker policy denied this operation' });
        return true;
      }
      const response = await brokerClient.decision({ requestId, ...body });
      publishWindowsBrokerApprovalInvalidation(response, { action: 'decision', requestId });
      writeJson(res, brokerHttpStatus(response), response);
    } catch (error) {
      writeUnavailable(writeJson, res, error);
    }
    return true;
  }

  if (pendingEnrollmentPath && req.method === 'GET') {
    try {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const deviceIds = query.getAll('deviceId');
      if (deviceIds.length !== 1 || !DEVICE_ID_PATTERN.test(deviceIds[0]) ||
          Array.from(query.keys()).some((key) => key !== 'deviceId')) {
        throw brokerError('BROKER_REQUEST_INVALID');
      }
      const response = await brokerClient.pendingEnrollment({ deviceId: deviceIds[0] });
      writeJson(res, brokerHttpStatus(response), response);
    } catch (error) {
      writeUnavailable(writeJson, res, error);
    }
    return true;
  }

  if (completeEnrollmentMatch && req.method === 'POST') {
    const enrollmentId = decodeRequestId(completeEnrollmentMatch[1]);
    if (!enrollmentId) {
      writeJson(res, 400, { code: 'BROKER_REQUEST_INVALID', error: 'Invalid Broker enrollment ID' });
      return true;
    }
    try {
      const body = await readJsonBody(req);
      if (!hasOnlyKeys(body, ['verificationCode', 'signature'])) throw brokerError('BROKER_REQUEST_INVALID');
      const response = await brokerClient.completeEnrollment({ enrollmentId, ...body });
      writeJson(res, brokerHttpStatus(response), response);
    } catch (error) {
      writeUnavailable(writeJson, res, error);
    }
    return true;
  }

  if (pendingPath && req.method === 'GET') {
    let deviceId;
    let cursor;
    try {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const deviceIds = query.getAll('deviceId');
      const cursors = query.getAll('cursor');
      const revisions = query.getAll('afterRevision');
      const waits = query.getAll('waitMs');
      if (deviceIds.length !== 1 || cursors.length > 1 ||
          revisions.length > 1 || waits.length > 1 ||
          !DEVICE_ID_PATTERN.test(deviceIds[0]) || (cursors[0] && !validId(cursors[0])) ||
          (revisions.length && (!/^[0-9a-f-]{36}:[0-9]{1,16}$/.test(revisions[0]) || cursors.length)) ||
          (waits.length && (!revisions.length || !/^[1-9][0-9]{0,4}$/.test(waits[0]) || Number(waits[0]) > 15_000))) {
        throw brokerError('BROKER_REQUEST_INVALID');
      }
      deviceId = deviceIds[0];
      cursor = cursors[0] || undefined;
      for (const key of query.keys()) {
        if (!['deviceId', 'cursor', 'afterRevision', 'waitMs'].includes(key)) {
          throw brokerError('BROKER_REQUEST_INVALID');
        }
      }
      const afterRevision = revisions[0];
      const waitMs = afterRevision ? (waits.length ? Number(waits[0]) : 15_000) : 0;
      const controller = new AbortController();
      const onClose = () => controller.abort();
      res.on?.('close', onClose);
      try {
        // This wait holds no privileged pipe. Only the signed pending snapshot
        // below calls Broker, after a change or a bounded timeout.
        if (afterRevision) {
          await waitForWindowsBrokerApprovalChange(deviceId, afterRevision, waitMs, controller.signal);
        }
        if (controller.signal.aborted) return true;
        if (afterRevision) {
          const authorization = reauthorizePending && await reauthorizePending(req, authSession);
          if (controller.signal.aborted) return true;
          if (authorization !== true && authorization?.allowed !== true) {
            const status = authorization?.status === 401 ? 401 : 403;
            writeJson(res, status, {
              code: status === 401 ? 'AUTHENTICATION_REQUIRED' : 'OWNER_ACCESS_REQUIRED',
              error: status === 401 ? 'Authentication required' : 'Owner access required',
            });
            return true;
          }
        }
        const revision = currentWindowsBrokerApprovalRevision();
        const response = await brokerClient.pending({ deviceId, cursor });
        if (!controller.signal.aborted) {
          writeJson(res, brokerHttpStatus(response), response?.type === 'pending'
            ? { ...response, revision } : response);
        }
      } finally {
        res.off?.('close', onClose);
      }
    } catch (error) {
      if (error?.code === 'BROKER_WAIT_CAPACITY') {
        writeJson(res, 429, { code: error.code, error: 'Broker pending wait capacity reached', retryAfterMs: 1_000 });
      } else {
        writeUnavailable(writeJson, res, error);
      }
    }
    return true;
  }

  req.resume?.();
  res.setHeader?.('Allow', pathname === BASE_PATH || decisionMatch || completeEnrollmentMatch ? 'POST' : 'GET');
  writeJson(res, 405, { code: 'METHOD_NOT_ALLOWED', error: 'Method not allowed' });
  return true;
}
