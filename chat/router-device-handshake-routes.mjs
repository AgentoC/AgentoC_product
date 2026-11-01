// Trusted-device handshake used by entry switching.
// Configuration sync endpoints were removed; this route only authenticates
// a paired device and issues a one-time credential for entry-switch introspection.
import { readBody } from '../lib/utils.mjs';
import { getCrossDeviceOwnerIdentity } from '../lib/owner-identity.mjs';
import { getTrustedDevicePublicKey } from './trusted-devices.mjs';
import {
  buildHandshakeMessage,
  isFreshTimestamp,
  verifyDeviceSignature,
  issueDeviceHandshakeToken,
} from '../lib/device-handshake.mjs';

const MAX_HANDSHAKE_BODY_BYTES = 8 * 1024;

export async function handleDeviceHandshakeRoutes({ req, res, pathname, writeJson }) {
  const isHandshakeRoute = pathname === '/api/device-handshake' || pathname === '/api/sync/handshake';
  if (!isHandshakeRoute || req.method !== 'POST') return false;

  const ownerIdentity = await getCrossDeviceOwnerIdentity();
  if (!ownerIdentity) {
    writeJson(res, 403, { error: 'This instance has no owner account binding.' });
    return true;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req, MAX_HANDSHAKE_BODY_BYTES));
  } catch {
    writeJson(res, 400, { error: 'Invalid handshake body.' });
    return true;
  }
  const deviceId = String(body?.deviceId || '').trim();
  const timestamp = String(body?.timestamp || '').trim();
  const signature = String(body?.signature || '').trim();
  if (!deviceId || !timestamp || !signature) {
    writeJson(res, 400, { error: 'deviceId, timestamp and signature are required.' });
    return true;
  }
  if (!isFreshTimestamp(timestamp)) {
    writeJson(res, 401, { error: 'Handshake timestamp expired or invalid.' });
    return true;
  }
  const publicKeyPem = await getTrustedDevicePublicKey(deviceId);
  if (!publicKeyPem) {
    writeJson(res, 409, { error: 'Device is not paired or has been revoked. Create a fresh pairing invitation.' });
    return true;
  }
  const valid = verifyDeviceSignature({
    message: buildHandshakeMessage({ deviceId, timestamp }),
    signature,
    publicKeyPem,
  });
  if (!valid) {
    writeJson(res, 401, { error: 'Invalid device signature.' });
    return true;
  }
  const { token, expiresAt } = await issueDeviceHandshakeToken({
    deviceId,
    ownerId: ownerIdentity.id,
    ownerKind: ownerIdentity.kind,
  });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ token, expiresAt }));
  return true;
}
