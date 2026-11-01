import { messageEvent } from '../normalizer.mjs';
import { getProviderCapabilities } from '../provider-contract.mjs';
import { getHarnessAdapterCompatibility } from '../harness-compatibility.mjs';

export const OPENHANDS_RUNTIME_FAMILY = 'openhands-headless';

export function createOpenHandsAdapter() {
  return { adapterCompatibility: getHarnessAdapterCompatibility('openhands'), capabilities: getProviderCapabilities(OPENHANDS_RUNTIME_FAMILY), parseLine(line) {
    const text = String(line || '').trim();
    return text ? [messageEvent('assistant', text, undefined, { provider: 'openhands', runtimeFamily: OPENHANDS_RUNTIME_FAMILY })] : [];
  }, flush() { return []; } };
}

export function buildOpenHandsArgs(prompt) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text) throw new Error('OpenHands requires a non-empty prompt');
  throw new Error('OpenHands Agent Canvas is a UI/agent-server launcher in this version and has no detached prompt CLI');
}
