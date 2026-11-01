import { createAcpEventParser } from './acp-stdio.mjs';
import { getProviderCapabilities } from '../provider-contract.mjs';
import { getHarnessAdapterCompatibility } from '../harness-compatibility.mjs';

export const KIMI_CODE_RUNTIME_FAMILY = 'kimi-code-acp';

export function createKimiCodeAdapter() {
  const parser = createAcpEventParser({ provider: 'kimi-code', runtimeFamily: KIMI_CODE_RUNTIME_FAMILY });
  return {
    adapterCompatibility: getHarnessAdapterCompatibility('kimi-code'),
    capabilities: getProviderCapabilities(KIMI_CODE_RUNTIME_FAMILY),
    parseLine(line) {
      return parser.parseLine(line);
    },
    flush() { parser.reset(); return []; },
  };
}

export function buildKimiCodeArgs(prompt) {
  const task = typeof prompt === 'string' ? prompt.trim() : '';
  if (!task) throw new Error('Kimi Code requires a non-empty prompt');
  return ['acp'];
}
