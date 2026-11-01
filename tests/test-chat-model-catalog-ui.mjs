#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(repoRoot, 'static/chat/tooling.js'), 'utf8');

function extractFunctionSource(functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const braceStart = source.indexOf('{', source.indexOf('(', start));
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

function makeOption(value, label, disabled = false) {
  return { value, textContent: label, label, disabled };
}

const context = {
  currentToolCatalogState: { status: 'unavailable', modelCount: 0, hasError: false },
  inlineModelSelect: {
    disabled: false,
    options: [makeOption('', 'default'), makeOption('model-a@provider-a', 'Model A')],
  },
  t(key) {
    return {
      'compose.catalog.loading': 'Loading models',
      'compose.catalog.stale': 'Cached models',
      'compose.catalog.empty': 'No models',
      'compose.catalog.unavailable': 'Unavailable',
      'compose.catalog.error': 'Catalog error',
      'tooling.defaultModel': 'default',
    }[key] || key;
  },
};
context.globalThis = context;

vm.runInNewContext([
  extractFunctionSource('normalizeComposerRuntimeModelCatalogState'),
  extractFunctionSource('getComposerRuntimeModelCatalogDisplayState'),
  extractFunctionSource('getComposerRuntimeModelCatalogStatusMessage'),
  extractFunctionSource('getComposerRuntimeModelOptions'),
  'globalThis.normalizeComposerRuntimeModelCatalogState = normalizeComposerRuntimeModelCatalogState;',
  'globalThis.getComposerRuntimeModelCatalogDisplayState = getComposerRuntimeModelCatalogDisplayState;',
  'globalThis.getComposerRuntimeModelCatalogStatusMessage = getComposerRuntimeModelCatalogStatusMessage;',
  'globalThis.getComposerRuntimeModelOptions = getComposerRuntimeModelOptions;',
].join('\n\n'), context, { filename: 'static/chat/tooling.js' });

const stale = context.normalizeComposerRuntimeModelCatalogState({
  catalog: {
    providerProfileId: 'provider-a',
    status: 'stale',
    models: [{ id: 'model-a@provider-a' }],
  },
}, 'provider-a');
assert.equal(stale.status, 'stale');
assert.equal(stale.modelCount, 1);
context.currentToolCatalogState = stale;
assert.equal(context.getComposerRuntimeModelCatalogDisplayState(), 'stale');
assert.equal(context.getComposerRuntimeModelCatalogStatusMessage(), 'Cached models');

const providerB = context.normalizeComposerRuntimeModelCatalogState({
  catalog: {
    providerProfileId: 'provider-a',
    status: 'stale',
    models: [{ id: 'model-a@provider-a' }],
  },
  catalogs: [{
    providerProfileId: 'provider-b',
    status: 'fresh',
    models: [{ id: 'model-b@provider-b' }],
  }],
}, 'provider-b');
assert.equal(providerB.providerProfileId, 'provider-b', 'provider selection must not reuse another direct catalog');
assert.equal(providerB.status, 'fresh');

const missingProvider = context.normalizeComposerRuntimeModelCatalogState({
  models: [{ id: 'model-a@provider-a' }],
  catalogs: [{
    providerProfileId: 'provider-a',
    status: 'fresh',
    models: [{ id: 'model-a@provider-a' }],
  }],
}, 'provider-b');
assert.equal(missingProvider.status, 'unavailable');
assert.equal(missingProvider.modelCount, 0);

context.currentToolCatalogState = { status: 'unavailable', modelCount: 0, hasError: true };
assert.equal(context.getComposerRuntimeModelCatalogDisplayState(), 'error');
assert.equal(context.getComposerRuntimeModelCatalogStatusMessage(), 'Catalog error');

context.currentToolCatalogState = { status: 'fresh', modelCount: 0, hasError: false };
assert.equal(context.getComposerRuntimeModelCatalogDisplayState(), 'empty');
assert.equal(context.getComposerRuntimeModelCatalogStatusMessage(), 'No models');

context.inlineModelSelect.disabled = true;
assert.equal(context.getComposerRuntimeModelOptions().every((option) => option.disabled), true);

console.log('test-chat-model-catalog-ui: provider scoping and catalog state presentation OK');
