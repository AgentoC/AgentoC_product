import { readBody } from '../lib/utils.mjs';
import {
  createTrustedDeviceAuthChallenge,
  verifyTrustedDeviceAuthChallenge,
} from './trusted-devices.mjs';
import { getClientIp, checkDevicePublicRateLimit } from './middleware.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function readJsonBody(req) {
  const body = await readBody(req, 64 * 1024);
  return body ? JSON.parse(body) : {};
}

export async function handleDeviceAuthPublicRoutes({ req, res, pathname, writeJson }) {
  if (pathname === '/api/device-auth/challenges' && req.method === 'POST') {
    res.setHeader('Cache-Control', 'no-store');
    const rateLimit = checkDevicePublicRateLimit(getClientIp(req));
    if (rateLimit.exceeded) {
      writeJson(res, 429, { error: 'Too many requests', retryAfterMs: rateLimit.retryAfterMs });
      return true;
    }
    try {
      const payload = await readJsonBody(req);
      const challenge = await createTrustedDeviceAuthChallenge(trimString(payload?.deviceId), {
        audience: trimString(payload?.audience),
        devicePublicKey: trimString(payload?.devicePublicKey),
      });
      writeJson(res, 201, { challenge });
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to create device challenge', code: error?.code });
    }
    return true;
  }

  if (pathname === '/api/device-auth/verify' && req.method === 'POST') {
    res.setHeader('Cache-Control', 'no-store');
    const rateLimit = checkDevicePublicRateLimit(getClientIp(req));
    if (rateLimit.exceeded) {
      writeJson(res, 429, { error: 'Too many requests', retryAfterMs: rateLimit.retryAfterMs });
      return true;
    }
    try {
      const payload = await readJsonBody(req);
      const result = await verifyTrustedDeviceAuthChallenge(payload);
      writeJson(res, 200, result);
    } catch (error) {
      writeJson(res, error?.statusCode || 400, { error: error.message || 'Failed to verify device signature', code: error?.code });
    }
    return true;
  }

  return false;
}
