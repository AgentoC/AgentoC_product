// Claude-compatible gateways have two model-selection paths: the foreground
// `--model` request and Claude Code's own small-model requests (for example
// automatic session titles).  A provider profile used to configure those
// paths independently, which let a stale `haiku` mapping fail after an
// otherwise successful turn.  This module freezes one concrete upstream
// model for every Claude Code path in a Run.

export const CLAUDE_MODEL_CONTRACT_VERSION = 1;

const TIER_ALIASES = new Set(['default', 'opus', 'sonnet', 'haiku', 'fable']);

function text(value, maxLength = 256) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function bareModel(value) {
  const raw = text(value);
  const at = raw.lastIndexOf('@');
  if (at <= 0 || at === raw.length - 1) return raw;
  return /^[A-Za-z0-9._-]+$/.test(raw.slice(at + 1)) ? raw.slice(0, at) : raw;
}

function policyTarget(policy, alias) {
  const normalized = text(alias).toLowerCase();
  if (!normalized) return '';
  if (normalized === 'default') return bareModel(policy?.defaultModel);
  return bareModel(policy?.[normalized]) || bareModel(policy?.defaultModel);
}

function catalogModelIds(catalog) {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  return new Set(models.map((entry) => bareModel(entry?.model || entry?.id)).filter(Boolean));
}

export function isClaudeTierAlias(value) {
  return TIER_ALIASES.has(text(value).toLowerCase());
}

// Returns an immutable, non-secret object that may be persisted with the Run.
// Gateways that genuinely offer separate tiers can opt into that policy later;
// until then every internal Claude Code request intentionally uses the exact
// model the user selected.  This is the only safe behavior for relays which
// advertise a flat GLM/DeepSeek model catalog.
export function buildClaudeModelContract({
  providerProfileId = '',
  providerRevision = '',
  requestedModel = '',
  snapshotModel = '',
  modelPolicy = null,
  catalog = null,
} = {}) {
  const requested = bareModel(requestedModel) || bareModel(snapshotModel);
  const policy = modelPolicy && typeof modelPolicy === 'object' && !Array.isArray(modelPolicy)
    ? modelPolicy
    : {};
  const selectedModel = !requested
    ? policyTarget(policy, 'default')
    : (isClaudeTierAlias(requested) ? policyTarget(policy, requested) : requested);
  if (!selectedModel) {
    return {
      ok: false,
      code: 'claude-model-contract-invalid',
      message: 'Claude provider has no concrete model for this Run.',
    };
  }

  const catalogIds = catalogModelIds(catalog);
  if (catalogIds.size > 0 && !catalogIds.has(selectedModel)) {
    return {
      ok: false,
      code: 'claude-model-contract-invalid',
      message: `Model ${selectedModel} is not available from the selected Claude provider.`,
      providerProfileId: text(providerProfileId),
      catalogVersion: text(catalog?.catalogVersion),
    };
  }

  const aliases = Object.freeze({
    default: selectedModel,
    opus: selectedModel,
    sonnet: selectedModel,
    haiku: selectedModel,
    fable: selectedModel,
    smallFast: selectedModel,
  });
  return {
    ok: true,
    contract: Object.freeze({
      version: CLAUDE_MODEL_CONTRACT_VERSION,
      providerProfileId: text(providerProfileId),
      providerRevision: text(providerRevision),
      model: selectedModel,
      aliases,
      ...(text(catalog?.catalogVersion) ? { catalogVersion: text(catalog.catalogVersion) } : {}),
      ...(text(catalog?.status) ? { catalogStatus: text(catalog.status, 32) } : {}),
      source: catalogIds.size > 0 ? 'catalog' : 'provider-policy',
    }),
  };
}

export function normalizeClaudeModelContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const providerProfileId = text(value.providerProfileId);
  const model = bareModel(value.model);
  const aliases = value.aliases && typeof value.aliases === 'object' && !Array.isArray(value.aliases)
    ? value.aliases
    : {};
  if (!model) return null;
  const normalizedAliases = {};
  for (const key of ['default', 'opus', 'sonnet', 'haiku', 'fable', 'smallFast']) {
    // Never trust a stored alias to point somewhere else than the frozen model.
    // This makes old/corrupt manifests fail safe instead of resurrecting a
    // rejected `glm-5-turbo` as a hidden title-generation model.
    const candidate = bareModel(aliases[key]);
    normalizedAliases[key] = candidate === model ? candidate : model;
  }
  return Object.freeze({
    version: CLAUDE_MODEL_CONTRACT_VERSION,
    providerProfileId,
    providerRevision: text(value.providerRevision),
    model,
    aliases: Object.freeze(normalizedAliases),
    ...(text(value.catalogVersion) ? { catalogVersion: text(value.catalogVersion) } : {}),
    ...(text(value.catalogStatus) ? { catalogStatus: text(value.catalogStatus, 32) } : {}),
    source: text(value.source, 64) || 'stored',
  });
}

export function resolveClaudeModelContract({
  contract = null,
  providerProfileId = '',
  providerRevision = '',
  requestedModel = '',
  snapshotModel = '',
  modelPolicy = null,
  catalog = null,
} = {}) {
  const stored = normalizeClaudeModelContract(contract);
  const wantedProvider = text(providerProfileId);
  const wantedModel = bareModel(requestedModel) || bareModel(snapshotModel);
  if (stored
    && (!wantedProvider || !stored.providerProfileId || stored.providerProfileId === wantedProvider)
    && (!text(providerRevision) || !stored.providerRevision || stored.providerRevision === text(providerRevision))
    && (!wantedModel || stored.model === wantedModel || isClaudeTierAlias(wantedModel))) {
    return { ok: true, contract: stored };
  }
  return buildClaudeModelContract({
    providerProfileId: wantedProvider,
    providerRevision,
    requestedModel,
    snapshotModel,
    modelPolicy,
    catalog,
  });
}
