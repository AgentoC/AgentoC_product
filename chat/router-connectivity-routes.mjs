import { readBody } from '../lib/utils.mjs';
import {
  getConnectivityStatus,
  listConnectionBootstrapReports,
  recordConnectivityProbe,
  retryConnectivityOnboarding,
  startConnectivityOnboarding,
} from './connectivity-state.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function readJsonBody(req) {
  const body = await readBody(req, 64 * 1024);
  return body ? JSON.parse(body) : {};
}

function invitationOptions(_req, payload = {}) {
  return {
    signalingEndpoint: trimString(payload.signalingEndpoint),
    ttlMs: Number(payload.ttlMs),
  };
}

export async function handleConnectivityOwnerRoutes({ req, res, pathname, authSession, writeJson }) {
  const trustedDevice = authSession?.principalKind === 'trusted_device';
  if ((pathname === '/api/connectivity/status' || pathname === '/api/onboarding/status') && req.method === 'GET') {
    writeJson(res, 200, { status: await getConnectivityStatus() });
    return true;
  }

  if (pathname === '/api/connectivity/candidates' && req.method === 'GET') {
    const status = await getConnectivityStatus();
    writeJson(res, 200, { candidates: status.candidates, probes: status.probes });
    return true;
  }

  if (pathname === '/api/connectivity/probes' && req.method === 'POST') {
    try {
      const probe = await recordConnectivityProbe(await readJsonBody(req));
      writeJson(res, 201, { probe });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to record connectivity probe' });
    }
    return true;
  }

  // 设备迁移证据的 owner 审计面：按 (deviceId, requestId) 去重后的上报序列，
  // 用于 M3-Fallback 验收对账（迁移不重复、不回退）。设备自身不需要回读。
  if (pathname === '/api/connectivity/bootstrap-reports' && req.method === 'GET') {
    if (trustedDevice) {
      writeJson(res, 403, { error: 'Trusted devices cannot read bootstrap migration reports' });
      return true;
    }
    writeJson(res, 200, { reports: await listConnectionBootstrapReports() });
    return true;
  }

  if ((pathname === '/api/onboarding/start' || pathname === '/api/onboarding/invitation/rotate') && req.method === 'POST') {
    if (trustedDevice) {
      writeJson(res, 403, { error: 'Trusted devices cannot rotate onboarding invitations' });
      return true;
    }
    try {
      const payload = await readJsonBody(req);
      writeJson(res, 201, await startConnectivityOnboarding(invitationOptions(req, payload)));
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to start onboarding' });
    }
    return true;
  }

  if (pathname === '/api/onboarding/retry' && req.method === 'POST') {
    if (trustedDevice) {
      writeJson(res, 403, { error: 'Trusted devices cannot restart onboarding' });
      return true;
    }
    try {
      const payload = await readJsonBody(req);
      writeJson(res, 200, await retryConnectivityOnboarding(invitationOptions(req, payload)));
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to retry onboarding' });
    }
    return true;
  }

  return false;
}
