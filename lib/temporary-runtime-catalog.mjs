import { CONFIG_DIR } from './config.mjs';
import { createNativeProviderRegistry } from './provider-runtime/registry.mjs';
import { createSecretStore } from './provider-runtime/secret-store.mjs';
import { resolveNativeSelectionFromManifest, resolveDefaultProviderProfileId } from './provider-runtime/run-provider-prepare.mjs';
import { resolveRuntimeConfig } from './provider-runtime/resolver.mjs';
import { resolveHarnessProviderCompatibility } from './provider-runtime/harness-bridge.mjs';

const publicReason = (reason) => ({
  'native-provider-not-selected': 'provider-not-configured',
  'provider-not-found': 'provider-not-configured',
  'provider-disabled': 'provider-disabled',
  'provider-not-ready': 'provider-not-ready',
  'credential-missing': 'credential-missing',
  'model-missing': 'model-not-configured',
  'harness-provider-api-key-required': 'provider-not-ready',
  'harness-provider-incompatible': 'provider-not-ready',
}[reason] || 'provider-not-ready');

/**
 * Resolves only public display fields for tools that can run now. It mirrors
 * the native provider resolver but never returns provider/auth ids, URLs,
 * credential references, secret values, or raw provider errors.
 */
export async function createTemporaryRuntimeCatalog(tools, {
  configDir = CONFIG_DIR,
  registry = createNativeProviderRegistry({ configDir }),
  secretStore = createSecretStore({ configDir }),
} = {}) {
  const rows = await Promise.all((Array.isArray(tools) ? tools : []).map(async (tool) => {
    const id = typeof tool?.id === 'string' ? tool.id.trim() : '';
    const name = typeof tool?.name === 'string' ? tool.name.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !name || tool.internalFallback === true) return null;

    let status = 'ready';
    const selection = resolveNativeSelectionFromManifest({ tool: id, options: { runtimeFamily: tool.runtimeFamily } });
    if (selection.agentType) {
      try {
        selection.providerProfileId ||= await resolveDefaultProviderProfileId(selection.agentType, {
          configDir, registry, harnessId: selection.harnessId,
        });
        if (!selection.providerProfileId) status = 'provider-not-configured';
        else {
          const provider = await registry.getProviderProfile(selection.providerProfileId);
          if (!provider) status = 'provider-not-configured';
          else if (provider.enabled === false || (provider.status && provider.status !== 'ready')) {
            status = provider.status === 'disabled' || provider.enabled === false
              ? 'provider-disabled' : 'provider-not-ready';
          } else {
            const authProfile = await registry.getAuthProfile(provider.authProfileId);
            if (!authProfile) status = 'provider-not-ready';
            else if (selection.agentType === 'harness') {
              const compatibility = resolveHarnessProviderCompatibility(selection.harnessId, provider);
              if (!compatibility.ok || authProfile.authType !== 'api-key') status = 'provider-not-ready';
            }
            if (status === 'ready') {
              try {
                await resolveRuntimeConfig({ runRequest: selection, registry, secretStore });
              } catch (error) {
                status = publicReason(error?.code);
              }
            }
          }
        }
      } catch {
        status = 'provider-not-ready';
      }
    }
    return Object.freeze({ id, name: name.slice(0, 96), ready: status === 'ready', status });
  }));
  return rows.filter(Boolean);
}
