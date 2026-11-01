/** Rechecks an Owner principal after a bounded pending wait, before opening Broker IPC. */
export function createWindowsBrokerPendingReauthorizer({
  authenticateTrustedDeviceToken,
  getAuthSession,
  devicePolicyEngine,
}) {
  const authenticationRequired = { allowed: false, status: 401, code: 'AUTHENTICATION_REQUIRED' };
  const accessDenied = { allowed: false, status: 403, code: 'OWNER_ACCESS_REQUIRED' };
  return async (req, original) => {
    if (original?.role !== 'owner' || original?.principalKind === 'run_capability') return accessDenied;
    let fresh;
    if (original.principalKind === 'trusted_device') {
      const authorization = req?.headers?.authorization || '';
      if (!authorization.startsWith('Bearer ')) return authenticationRequired;
      const token = authorization.slice(7).trim();
      if (!token) return authenticationRequired;
      fresh = await authenticateTrustedDeviceToken(token);
      if (fresh?.principalKind !== 'trusted_device' || fresh?.deviceId !== original.deviceId) {
        return authenticationRequired;
      }
      const decision = devicePolicyEngine.decide({
        method: req.method,
        url: req.url,
        headers: { authorization },
      });
      if (decision.kind === 'blocked') return accessDenied;
      if (decision.kind === 'unauthorized') return authenticationRequired;
    } else {
      fresh = getAuthSession(req);
    }
    if (fresh?.role !== 'owner' || fresh?.principalKind === 'run_capability') return authenticationRequired;
    for (const key of ['principalId', 'accountId', 'bindingAuthorityRevision']) {
      if ((fresh[key] ?? null) !== (original[key] ?? null)) return authenticationRequired;
    }
    if (Number.isFinite(fresh.expiry) && fresh.expiry <= Date.now()) return authenticationRequired;
    return { allowed: true };
  };
}
