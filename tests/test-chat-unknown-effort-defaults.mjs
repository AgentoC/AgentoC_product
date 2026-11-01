#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(repoRoot, 'static/chat/tooling.js'), 'utf8');

function extractFunctionSource(name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const braceStart = source.indexOf('{', source.indexOf('(', start));
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract ${name}`);
}

function resolve({ tool, runtimeFamily, model }) {
  const context = {
    selectedTool: tool,
    selectedModel: model.id,
    currentToolBaseReasoning: { kind: 'none', label: 'Thinking' },
    currentToolModels: [model],
    t: () => 'Thinking',
    getSelectedToolDefinition: () => ({ runtimeFamily }),
  };
  vm.runInNewContext([
    'const UNKNOWN_RUNTIME_EFFORT_DEFAULTS = Object.freeze({ codex: Object.freeze(["low", "medium", "high", "xhigh"]), claude: Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]) });',
    extractFunctionSource('cloneReasoningState'),
    extractFunctionSource('findCurrentToolModelRecord'),
    extractFunctionSource('resolveActiveReasoningState'),
    'globalThis.result = resolveActiveReasoningState();',
  ].join('\n\n'), context);
  return JSON.parse(JSON.stringify(context.result.reasoning));
}

assert.deepEqual(resolve({
  tool: 'codex',
  runtimeFamily: 'codex-json',
  model: { id: 'proxy-model', capabilities: { effort: { supported: null } } },
}), { kind: 'enum', label: 'Thinking', levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium' });

assert.deepEqual(resolve({
  tool: 'claude-bidi',
  runtimeFamily: 'claude-stream-json-bidi',
  model: { id: 'proxy-model', capabilities: { effort: { supported: null } } },
}), { kind: 'enum', label: 'Thinking', levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' });

assert.deepEqual(resolve({
  tool: 'codex',
  runtimeFamily: 'codex-json',
  model: { id: 'unsupported', capabilities: { effort: { supported: false } } },
}), { kind: 'none', label: 'Thinking' });

console.log('test-chat-unknown-effort-defaults: unknown runtime defaults and explicit unsupported state OK');
