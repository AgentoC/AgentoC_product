import { SEMANTIC_ADAPTER_WINDOWS_SERVICE_CONTROL_V1, validateSemanticCapability } from './semantic-capability.mjs';
import { revalidateWindowsServiceFacts } from './windows-runtime-facts-provider.mjs';

// This produces a typed service operation, not a shell command. The final
// native executor must independently revalidate the definition and bind the
// action to the same service handle before actually changing its state.
export async function revalidateWindowsServiceControl(capability, { provider, now = Date.now() } = {}) {
  const checked = validateSemanticCapability(capability, { now });
  if (!checked.ok || capability.adapter !== SEMANTIC_ADAPTER_WINDOWS_SERVICE_CONTROL_V1) {
    return { ok: false, code: checked.code || 'WINDOWS_SERVICE_CAPABILITY_INVALID', error: checked.error || 'Windows service capability is invalid' };
  }
  const input = capability.operations[0].adapterInput;
  const result = await revalidateWindowsServiceFacts({ serviceName: input.serviceName, definitionHash: input.definitionHash, action: input.serviceAction }, { provider });
  if (!result.ok) return result;
  return { ok: true, invocation: { kind: 'windows-service-control', serviceName: input.serviceName,
    action: input.serviceAction, definitionHash: input.definitionHash } };
}
