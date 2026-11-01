import { createHash } from 'crypto';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createCandidateId(value) {
  return `cand_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function candidate({ kind, provider, endpoint, priority, expiresAt, metadata = {} }) {
  const normalizedEndpoint = trimString(endpoint);
  if (!normalizedEndpoint) return null;
  return {
    id: createCandidateId(`${kind}\n${provider}\n${normalizedEndpoint}`),
    kind,
    provider,
    endpoint: normalizedEndpoint,
    priority,
    expiresAt: trimString(expiresAt),
    metadata,
  };
}

export function createConnectivityCandidates(policy, context = {}) {
  const source = policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : {};
  const expiresAt = trimString(context.expiresAt);
  const candidates = [];
  if (source?.p2p?.enabled && source.p2p.signalingEndpoint) {
    candidates.push(candidate({
      kind: 'webrtc',
      provider: 'core_p2p',
      endpoint: source.p2p.signalingEndpoint,
      priority: 50,
      expiresAt,
      metadata: {
        roomId: trimString(context.p2pRoomId),
        turnAllowed: false,
      },
    }));
  }
  return candidates.filter(Boolean);
}

export function normalizeConnectivityCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = trimString(value.kind);
  const provider = trimString(value.provider);
  const endpoint = trimString(value.endpoint);
  const id = trimString(value.id) || createCandidateId(`${kind}\n${provider}\n${endpoint}`);
  if (!kind || !provider || !endpoint) return null;
  return {
    id,
    kind,
    provider,
    endpoint,
    priority: Number.isFinite(Number(value.priority)) ? Number(value.priority) : 0,
    expiresAt: trimString(value.expiresAt),
    metadata: value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)
      ? value.metadata
      : {},
  };
}
