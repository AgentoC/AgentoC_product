export async function handleAccountPairingOwnerRoutes({ req, res, pathname, authSession, writeJson,
  getService = async () => (await import('./account-pairing-service.mjs')).getAccountPairingService() }) {
  if (!pathname.startsWith('/api/device-pairing/account-invitations/')) return false;
  if (authSession?.role !== 'owner' || (authSession.principalKind && authSession.principalKind !== 'owner')) {
    writeJson(res, 403, { code: 'account_pairing_owner_required' }); return true;
  }
  const route = /^\/api\/device-pairing\/account-invitations\/([A-Za-z0-9_-]{16,160})(?:\/(approve|revoke))?$/.exec(pathname);
  if (!route) { writeJson(res, 404, { code: 'account_pairing_route_unknown' }); return true; }
  if (req.method !== (route[2] ? 'POST' : 'GET')) { writeJson(res, 405, { code: 'account_pairing_method_not_allowed' }); return true; }
  res.setHeader?.('Cache-Control', 'no-store, max-age=0');
  try {
    const service = await getService();
    const result = await service[route[2] || 'status'](route[1]);
    writeJson(res, 200, { invitation: { instanceId: result.instanceId, invitationId: result.invitationId,
      status: result.status, expiresAt: result.expiresAt,
      phoneFingerprint: result.claim?.publicKeyFingerprint || null } });
  } catch (error) {
    writeJson(res, error.statusCode || 503, { code: /^account_pairing_[a-z_]+$/.test(error?.code || '') ? error.code : 'account_pairing_unavailable' });
  }
  return true;
}
