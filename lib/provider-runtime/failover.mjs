// Native provider failover policy. This module is deliberately pure so the
// session finalizer can classify a provider failure without mutating the
// global registry or making a second Run share the first Run's snapshot.

const AUTH_FAILURE_RE = /\b(?:401|403)\b|unauthori[sz]ed|invalid\s+(?:api\s*key|token)|refresh\s+token|token\s+(?:expired|already\s+used)|insufficient\s+(?:quota|balance)|billing|credit\s+limit/i;
const CONFIG_FAILURE_RE = /wire_api|unsupported\s+(?:model|endpoint|protocol|api)|\bmodel\b.*\b(?:not\s+found|not\s+supported|does\s+not\s+exist)\b|missing\s+function\.name|invalid\s+(?:request|model)|no\s+such\s+model/i;
const TRANSIENT_FAILURE_RE = /\b(?:408|409|429|500|502|503|504)\b|timeout|timed\s*out|connection\s+(?:reset|closed|aborted)|econnreset|econnrefused|stream[_ -]truncated|no\s+output\s+was\s+produced|upstream[_ -]error|temporar(?:y|ily)|overloaded|rate\s*limit/i;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function classifyProviderFailure(value) {
  const message = typeof value === 'string'
    ? value.trim()
    : (typeof value?.message === 'string' ? value.message.trim() : '');
  if (!message) return { kind: 'unknown', message: '' };
  if (AUTH_FAILURE_RE.test(message)) return { kind: 'auth', message };
  if (CONFIG_FAILURE_RE.test(message)) return { kind: 'configuration', message };
  if (TRANSIENT_FAILURE_RE.test(message)) return { kind: 'transient', message };
  return { kind: 'unknown', message };
}

export function shouldFailoverProvider({ failureReason, attempt = 0 } = {}) {
  if (Number(attempt) > 0) return false;
  const classification = classifyProviderFailure(failureReason);
  return classification.kind === 'configuration' || classification.kind === 'transient';
}

export function hasProviderSideEffects(events = []) {
  const sideEffectTypes = new Set([
    'approval_request',
    'approval_response',
    'privileged_batch_request',
    'privileged_batch_response',
    'tool_call',
    'tool_use',
    'command_execution',
    'file_change',
  ]);
  return (Array.isArray(events) ? events : []).some((event) => {
    const type = String(event?.type || event?.method || '').trim().toLowerCase();
    return sideEffectTypes.has(type)
      || type.includes('tool')
      || type.includes('approval')
      || type.includes('command_execution');
  });
}

export function bareProviderModel(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1) return raw;
  return /^[A-Za-z0-9._-]+$/.test(raw.slice(at + 1)) ? raw.slice(0, at) : raw;
}

function providerPolicyModels(profile) {
  const entries = Array.isArray(profile?.modelPolicy?.models)
    ? profile.modelPolicy.models
    : [];
  return entries
    .map((entry) => (typeof entry === 'string' ? entry.trim() : trimString(entry?.id)))
    .filter(Boolean);
}

export function resolveProviderFailoverModel(profile, requestedModel, agentType = 'codex') {
  const model = bareProviderModel(requestedModel);
  if (!model) return null;

  if (agentType === 'claude' && ['sonnet', 'opus', 'haiku'].includes(model)) {
    // Claude's public model picker uses stable tier aliases while the
    // provider policy maps those aliases to each gateway's concrete model.
    const policy = profile?.modelPolicy && typeof profile.modelPolicy === 'object'
      ? profile.modelPolicy
      : {};
    if (trimString(policy[model]) || trimString(policy.defaultModel)) {
      return { model, exactModel: true };
    }
    // Official/imported Claude rows may intentionally have no model policy;
    // Claude Code can resolve its own tier alias in that provider home.
    if (providerPolicyModels(profile).length === 0) {
      return { model, exactModel: true };
    }
    return null;
  }

  const models = providerPolicyModels(profile);
  if (models.length > 0) {
    if (!models.includes(model)) return null;
    return { model, exactModel: true };
  }

  // A legacy/imported row may not have a catalog. Only use its default when
  // it is the same model; otherwise switching would silently change the
  // user's requested model.
  const defaultModel = bareProviderModel(trimString(profile?.modelPolicy?.defaultModel));
  if (defaultModel && defaultModel !== model) return null;
  return { model, exactModel: true };
}

export function rankProviderFailoverCandidates(candidates = [], { currentProtocol = '' } = {}) {
  return [...(Array.isArray(candidates) ? candidates : [])].sort((a, b) => {
    const aExact = a.exactModel ? 1 : 0;
    const bExact = b.exactModel ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    const aProtocol = a.protocol === currentProtocol ? 1 : 0;
    const bProtocol = b.protocol === currentProtocol ? 1 : 0;
    if (aProtocol !== bProtocol) return bProtocol - aProtocol;
    return String(a.displayName || a.id).localeCompare(String(b.displayName || b.id));
  });
}
