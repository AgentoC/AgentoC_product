import { createAcpEventParser } from './acp-stdio.mjs';
import { getProviderCapabilities } from '../provider-contract.mjs';
import { getHarnessAdapterCompatibility } from '../harness-compatibility.mjs';

export const QWEN_CODE_RUNTIME_FAMILY = 'qwen-code-acp';

export function createQwenCodeAdapter() {
  const parser = createAcpEventParser({ provider: 'qwen-code', runtimeFamily: QWEN_CODE_RUNTIME_FAMILY });
  return {
    adapterCompatibility: getHarnessAdapterCompatibility('qwen-code'),
    capabilities: getProviderCapabilities(QWEN_CODE_RUNTIME_FAMILY),
    parseLine(line) {
      return parser.parseLine(line);
    },
    flush() { parser.reset(); return []; },
  };
}

export function buildQwenCodeArgs(prompt, { model = '', riskMode = '' } = {}) {
  const task = typeof prompt === 'string' ? prompt.trim() : '';
  if (!task) throw new Error('Qwen Code requires a non-empty prompt');
  const args = ['--acp'];
  if (riskMode === 'full-auto') args.push('--approval-mode', 'yolo');
  if (riskMode === 'conservative-auto') args.push('--approval-mode', 'auto');
  const selectedModel = typeof model === 'string' ? model.trim().split('@')[0] : '';
  if (selectedModel) args.push('--model', selectedModel);
  return args;
}
