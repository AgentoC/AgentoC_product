#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const paramsStart = source.indexOf('(', start);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

function makeCard(providerToolUseId, completed = false) {
  return {
    dataset: providerToolUseId ? { providerToolUseId } : {},
    querySelector(selector) {
      if (selector === '.tool-result') return completed ? {} : null;
      return null;
    },
  };
}

const context = { console };
context.globalThis = context;
vm.runInNewContext(
  `${extractFunctionSource(uiSource, 'findPendingToolCard')}\n`
    + 'globalThis.findPendingToolCard = findPendingToolCard;',
  context,
  { filename: 'static/chat/ui.js' },
);

const cardA = makeCard('toolu_a');
const cardB = makeCard('toolu_b');
const root = {
  querySelectorAll(selector) {
    assert.equal(selector, '.tool-card');
    return [cardA, cardB];
  },
};

assert.equal(
  context.findPendingToolCard(root, { providerToolUseId: 'toolu_a' }),
  cardA,
  'provider tool id should beat latest-card order',
);
assert.equal(
  context.findPendingToolCard(root, { providerToolUseId: 'toolu_b' }),
  cardB,
  'provider tool id should resolve the matching card',
);
assert.equal(
  context.findPendingToolCard(root, { providerToolUseId: 'missing' }),
  null,
  'a result with an id must not attach to an unrelated pending card',
);
assert.equal(
  context.findPendingToolCard(root, {}),
  cardB,
  'legacy results without ids should keep the latest pending fallback',
);

const completedB = makeCard('toolu_b', true);
assert.equal(
  context.findPendingToolCard({ querySelectorAll: () => [cardA, completedB] }, { providerToolUseId: 'toolu_b' }),
  null,
  'completed cards should not accept another result',
);

assert.match(uiSource, /card\.dataset\.providerToolUseId = evt\.providerToolUseId/);
assert.match(uiSource, /findPendingToolCard\(container, evt\)/);

console.log('test-chat-tool-result-correlation: ok');
