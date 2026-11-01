function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeConnectivityPolicy(value, endpoint = '') {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    order: Array.isArray(source?.order) ? source.order.filter((value) => value === 'p2p') : ['p2p'],
    p2p: {
      enabled: source?.p2p?.enabled === true,
      signalingEndpoint: trimString(source?.p2p?.signalingEndpoint || ''),
      turnAllowed: false,
    },
    version: Number.isFinite(Number(source?.version)) ? Number(source.version) : 2,
  };
}

export function createConnectivityPolicy({ signalingEndpoint, protocolVersion } = {}) {
  const sigEndpoint = trimString(signalingEndpoint || '');
  return {
    order: sigEndpoint ? ['p2p'] : [],
    p2p: {
      enabled: !!sigEndpoint,
      signalingEndpoint: sigEndpoint,
      turnAllowed: false,
    },
    version: Number.isFinite(Number(protocolVersion)) ? Number(protocolVersion) : 2,
  };
}
