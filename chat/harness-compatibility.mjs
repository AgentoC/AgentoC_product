import { HARNESS_VERSION_CONTRACTS } from '../lib/harness-version-catalog.mjs';

// Compatibility is deliberately versioned at the adapter boundary.  A
// harness upgrade is allowed only when the adapter has an entry here.
const PACKAGES = Object.freeze({ codex: '@openai/codex', claude: '@anthropic-ai/claude-code',
  agy: 'agy', pi: '@earendil-works/pi-coding-agent', 'deepseek-harness': '@deepseek-ai/dsh',
  'qwen-code': '@qwen-code/qwen-code', opencode: 'opencode-ai', 'kimi-code': '@moonshot-ai/kimi-code',
  goose: 'goose', openhands: '@openhands/agent-canvas', copilot: '@github/copilot',
  hermes: 'hermes-agent', cline: 'cline', kilo: '@kilocode/cli' });
export const HARNESS_ADAPTER_COMPATIBILITY = Object.freeze(Object.fromEntries(
  Object.entries(HARNESS_VERSION_CONTRACTS).map(([id, value]) => [id, Object.freeze({
    ...value, harness: PACKAGES[id], ...(id === 'openhands' ? { serviceRuntime: 'openhands-agent-server' } : {}),
  })]),
));

export function getHarnessAdapterCompatibility(id, policy = null) {
  const value = HARNESS_ADAPTER_COMPATIBILITY[String(id || '').trim()];
  if (!value) return null;
  const override = policy && typeof policy === 'object' ? policy : {};
  return {
    ...value,
    ...(override.minimumVersion && isConcreteVersion(override.minimumVersion)
      && (!value.minimumVersion || compareVersions(override.minimumVersion, value.minimumVersion) > 0)
      ? { minimumVersion: String(override.minimumVersion).trim() } : {}),
    ...(override.serviceRuntimeMinimumVersion ? { serviceRuntimeMinimumVersion: String(override.serviceRuntimeMinimumVersion).trim() } : {}),
    compatibleVersions: [...(override.compatibleVersions || value.compatibleVersions)],
  };
}

export function isAdapterCompatible(id, version, policy = null) {
  const compatibility = getHarnessAdapterCompatibility(id, policy);
  const value = String(version || '').trim().replace(/^v/i, '');
  if (!compatibility || !value) return false;
  if (!isConcreteVersion(value)) return false;
  if (compatibility.minimumVersion && compareVersions(value, compatibility.minimumVersion) < 0) return false;
  if (compatibility.maximumVersion && compareVersions(value, compatibility.maximumVersion) > 0) return false;
  const admitted = (patterns) => patterns.some((pattern) => pattern === value
    || (!value.includes('-') && (
      (pattern.startsWith('>=') && compareVersions(value, pattern.slice(2)) >= 0)
      || (pattern.endsWith('.x') && value.startsWith(pattern.slice(0, -1)))
      // An installer channel is still bounded by the local maximum above.
      || pattern === 'latest' || pattern === '*')));
  return admitted(HARNESS_ADAPTER_COMPATIBILITY[String(id || '').trim()].compatibleVersions)
    && admitted(compatibility.compatibleVersions);
}

function isConcreteVersion(value) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function compareVersions(left, right) {
  const parse = (value) => String(value || '').replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  if (a.some((part) => !Number.isInteger(part)) || b.some((part) => !Number.isInteger(part))) return Number.NaN;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta) return delta;
  }
  return 0;
}
