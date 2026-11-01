// Adapter from the authenticated v2 P2P carrier to the existing business
// router.  It is intentionally in-process: no header can opt an internet HTTP
// request into this path.
import { authorizeTemporaryControl } from '../lib/temporary-control-policy.mjs';
import { temporaryControlCarrierRoute } from '../lib/temporary-control-routes.mjs';

function fail(code, statusCode = 403) {
  return Object.assign(new Error(code), { code, statusCode });
}

function ownerPath(route) {
  let path = route.pathname.replace(/^\/api\/temporary-control\/v1\/instances\/inst_[A-Za-z0-9_-]{24,64}/, '/api');
  // The mobile carrier intentionally uses a neutral provider collection name;
  // the desktop API's existing, audited surface calls it native-providers.
  path = path === '/api/providers'
    ? '/api/native-providers'
    : path.replace(/^\/api\/providers\//, '/api/native-providers/');
  // A run projection contains the authoritative pending approval set. There
  // is no separate Owner endpoint to list it.
  if (route.operation === 'approval.list') path = `/api/runs/${encodeURIComponent(route.args[0])}`;
  return path + route.search;
}

function sendFailure(res, error) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(error?.statusCode || 503, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store' });
  res.end(JSON.stringify({ code: error?.code || 'temporary_control_request_failed' }));
}

/**
 * `authenticate` must verify the fresh device proof and revalidate the
 * registry grant. It returns the temporary principal; this adapter never
 * accepts one from request headers or a request body.
 */
export function createTemporaryControlCarrierIngress({ authenticate, carrierDevice = null, revalidate = async () => {}, dispatch = null } = {}) {
  if (typeof authenticate !== 'function') throw new TypeError('authenticate is required');
  const dispatchRequest = dispatch || (async (req, res) => {
    const { handleRequest } = await import('./router.mjs');
    return handleRequest(req, res);
  });
  return async function handleTemporaryControlCarrierRequest(req, res) {
    const route = temporaryControlCarrierRoute(req.method, req.url);
    if (!route) { sendFailure(res, fail('temporary_control_route_denied')); return; }
    try {
      const principal = await authenticate({ req, route });
      if (carrierDevice && (principal.instanceId !== carrierDevice.instanceId
        || principal.grantId !== carrierDevice.grantId || principal.deviceId !== carrierDevice.deviceId
        || principal.expiry !== carrierDevice.accessExpiresAt)) throw fail('temporary_control_carrier_mismatch');
      authorizeTemporaryControl(principal, route.operation);
      // Existing business handlers have historical role checks. The explicit
      // principal kind, carrier marker, and pre-dispatch capability gate keep
      // this compatibility shape from becoming Owner authority.
      req._bearerAuthSession = Object.freeze({ ...principal, role: 'owner',
        temporaryControlAdapter: true, temporaryControlOriginalRole: 'temporary' });
      req._temporaryControlAdapter = true;
      req._temporaryControlOperation = route.operation;
      req.url = ownerPath(route);
      await dispatchRequest(req, res);
      await revalidate(principal);
    } catch (error) {
      sendFailure(res, error);
    }
  };
}
