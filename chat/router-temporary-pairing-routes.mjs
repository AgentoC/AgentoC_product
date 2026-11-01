import { temporaryPairingError } from '../lib/temporary-pairing-protocol.mjs';

export async function handleTemporaryPairingOwnerRoutes({ req, res, pathname, authSession, writeJson,
  getHost = async () => (await import('./temporary-pairing-runtime.mjs')).getTemporaryPairingHost(),
  getAccountBinding = async () => (await import('../lib/owner-account-auth.mjs')).getOwnerAccountBinding(),
  getControlService = async () => (await import('./temporary-control-runtime.mjs')).getTemporaryControlService() }) {
  const prefix = '/api/device-pairing/temporary/invitations';
  const controlPrefix = '/api/device-pairing/temporary-control/invitations';
  const isControl = pathname === controlPrefix || pathname.startsWith(`${controlPrefix}/`);
  if (!isControl && pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return false;
  res.setHeader?.('Cache-Control', 'no-store, max-age=0');
  if (authSession?.role !== 'owner' || (authSession.principalKind && authSession.principalKind !== 'owner')) {
    writeJson(res, 403, { code: 'temporary_host_owner_required' }); return true;
  }
  if (isControl) {
    const revoke = new RegExp(`^${controlPrefix}/(rti_[A-Za-z0-9_-]{24,64})/revoke$`).exec(pathname);
    const confirm = new RegExp(`^${controlPrefix}/(rti_[A-Za-z0-9_-]{24,64})/confirm$`).exec(pathname);
    if (pathname !== controlPrefix && !revoke && !confirm) {
      writeJson(res, 404, { code: 'temporary_control_route_unknown' }); return true;
    }
    if ((revoke || confirm) ? req.method !== 'POST' : !['GET', 'POST'].includes(req.method)) {
      writeJson(res, 405, { code: 'temporary_control_method_not_allowed' }); return true;
    }
    try {
      const service = await getControlService();
      if (revoke) writeJson(res, 200, { invitation: await service.revoke(revoke[1]) });
      else if (confirm) writeJson(res, 200, { invitation: await service.confirm(confirm[1]) });
      else if (req.method === 'GET') writeJson(res, 200, { invitations: await service.list() });
      else {
        if (await getAccountBinding()) throw temporaryPairingError('temporary_control_use_account_pairing', 409);
        let size = 0;
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk);
          if (size > 1024) throw temporaryPairingError('temporary_control_body_too_large', 413);
        }
        writeJson(res, 201, { invitation: await service.create() });
      }
    } catch (error) {
      writeJson(res, error.statusCode || 503, {
        code: /^temporary_(?:control|host)_[a-z0-9_]{1,65}$/.test(error?.code || '')
          ? error.code : 'temporary_control_request_failed',
      });
    }
    return true;
  }
  const revoke = /^\/api\/device-pairing\/temporary\/invitations\/(rti_[A-Za-z0-9_-]{24,64})\/revoke$/.exec(pathname);
  if (pathname !== prefix && !revoke) { writeJson(res, 404, { code: 'temporary_host_route_unknown' }); return true; }
  if ((revoke && req.method !== 'POST') || (!revoke && !['GET', 'POST'].includes(req.method))) {
    writeJson(res, 405, { code: 'temporary_host_method_not_allowed' }); return true;
  }
  try {
    const host = await getHost();
    if (revoke) {
      writeJson(res, 200, { invitation: await host.revoke(revoke[1]), businessAccessReady: false });
    } else if (req.method === 'GET') {
      writeJson(res, 200, { invitations: await host.list(), businessAccessReady: false });
    } else {
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        const data = Buffer.from(chunk); size += data.length;
        if (size > 16 * 1024) throw temporaryPairingError('temporary_host_body_too_large', 413);
        chunks.push(data);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : {};
      if (!body || Array.isArray(body) || typeof body !== 'object'
        || Object.keys(body).some((k) => !['capabilities', 'claimTtlMs', 'accessTtlMs'].includes(k))) {
        throw temporaryPairingError('temporary_host_request_invalid');
      }
      writeJson(res, 201, { invitation: await host.create(body) });
    }
  } catch (error) {
    writeJson(res, error.statusCode || (error instanceof SyntaxError ? 400 : 503), {
      code: /^temporary_[a-z0-9_]{1,65}$/.test(error?.code || '') ? error.code : 'temporary_host_request_failed',
    });
  }
  return true;
}
