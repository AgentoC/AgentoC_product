/** Temporary requests cannot fall through to local-web auto-owner or public account routes.
 * A future explicitly authenticated adapter must consume them before this final closed gate.
 */
export function rejectUnadaptedTemporaryRequest(req, res) {
  // The P2P-only v2 carrier sets this marker after it has authenticated the
  // device and selected a single allowlisted business route. It is an
  // in-process property, never an HTTP header.
  if (req?._temporaryControlAdapter === true) return false;
  const authorization = String(req.headers?.authorization || '');
  const principal = req._bearerAuthSession;
  if (!/^\s*DPoP(?:\s|$)/i.test(authorization)
    && !Object.hasOwn(req.headers || {}, 'dpop')
    && principal?.role !== 'temporary' && principal?.principalKind !== 'temporary_device') return false;
  req.resume?.();
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
  res.end(JSON.stringify({ code: 'temporary_business_not_ready', error: 'Temporary business access is not enabled' }));
  return true;
}
