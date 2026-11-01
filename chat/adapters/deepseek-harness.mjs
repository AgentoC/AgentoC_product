import { messageEvent } from '../normalizer.mjs';
import { createAcpEventParser } from './acp-stdio.mjs';
import { getProviderCapabilities } from '../provider-contract.mjs';
import { getHarnessAdapterCompatibility } from '../harness-compatibility.mjs';

export const DEEPSEEK_HARNESS_RUNTIME_FAMILY = 'deepseek-harness-acp';

// The published dsh package exposes a stable one-shot headless entry point.
// Its stdout contract is the committed assistant answer; diagnostics belong
// on stderr. This adapter intentionally models headless semantics, while the
// ACP demo remains a separate future long-lived transport.
export function createDeepSeekHarnessAdapter() {
  const parser = createAcpEventParser({
    provider: 'deepseek-harness',
    runtimeFamily: DEEPSEEK_HARNESS_RUNTIME_FAMILY,
  });
  return {
    adapterCompatibility: getHarnessAdapterCompatibility('deepseek-harness'),
    capabilities: getProviderCapabilities(DEEPSEEK_HARNESS_RUNTIME_FAMILY),
    parseLine(line) {
      const acpEvents = parser.parseLine(line);
      if (acpEvents.length > 0) return acpEvents;
      const content = String(line || '').trim();
      if (!content) return [];
      try {
        JSON.parse(content);
        return [];
      } catch {
        // The headless profile emits only the committed response as plain text.
      }
      return [messageEvent('assistant', content, undefined, {
        provider: 'deepseek-harness', runtimeFamily: DEEPSEEK_HARNESS_RUNTIME_FAMILY,
      })];
    },
    flush() { parser.reset(); return []; },
  };
}

export function buildDeepSeekHarnessArgs(prompt, { profile = 'headless' } = {}) {
  const task = typeof prompt === 'string' ? prompt.trim() : '';
  if (!task) throw new Error('DeepSeek Harness requires a non-empty prompt');
  return ['--profile', profile, task];
}

export function buildDeepSeekHarnessAcpArgs({ configPath } = {}) {
  const config = typeof configPath === 'string' ? configPath.trim() : '';
  if (!config) throw new Error('DeepSeek Harness ACP requires an explicit cordis config path');
  return ['--config', config];
}
