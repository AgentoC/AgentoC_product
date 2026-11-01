#!/usr/bin/env node
// 会话优先继承 runtime 选择（provider/model）的前端契约测试：
// 1. 会话从未固定 provider/model → 继承"任意会话中最近一次选择"（lastRuntimeSelection_）。
// 2. 会话自带 provider/model → 原样使用，不继承。
// 3. 旧 selectedProvider_/selectedModel_ 键迁移回退。
// 4. rememberGlobalRuntimeSelection 成对写入，防两个旧键互相过期。
// 5. 继承的 provider 参与模型列表过滤（含 provider 无可用模型时的回退语义）。
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const toolingSource = readFileSync(join(repoRoot, 'static', 'chat', 'tooling.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  let start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  if (source.slice(Math.max(0, start - 6), start) === 'async ') {
    start -= 6;
  }
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

function makeContext({ session = null, storageEntries = new Map() } = {}) {
  const storage = storageEntries;
  const context = {
    console,
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
    getCurrentSession() { return session; },
    getSelectedToolDefinition() { return { runtimeFamily: '' }; },
  };
  context.globalThis = context;
  return context;
}

function loadHelpers(context) {
  vm.runInNewContext([
    extractFunctionSource(toolingSource, 'parseScopedModelProvider'),
    extractFunctionSource(toolingSource, 'readLastGlobalRuntimeSelection'),
    extractFunctionSource(toolingSource, 'getLastGlobalRuntimeSelection'),
    extractFunctionSource(toolingSource, 'rememberGlobalRuntimeSelection'),
    extractFunctionSource(toolingSource, 'getAttachedSessionToolPreferences'),
    extractFunctionSource(toolingSource, 'filterModelsForSessionProvider'),
    'globalThis.parseScopedModelProvider = parseScopedModelProvider;',
    'globalThis.getLastGlobalRuntimeSelection = getLastGlobalRuntimeSelection;',
    'globalThis.rememberGlobalRuntimeSelection = rememberGlobalRuntimeSelection;',
    'globalThis.getAttachedSessionToolPreferences = getAttachedSessionToolPreferences;',
    'globalThis.filterModelsForSessionProvider = filterModelsForSessionProvider;',
  ].join('\n\n'), context, { filename: 'session-runtime-inheritance.js' });
}

// —— 1. 无固定 provider/model 的会话继承全局最近选择 ——
{
  const context = makeContext({
    session: { id: 'session-legacy', tool: 'codex' },
    storageEntries: new Map([
      ['lastRuntimeSelection_codex', JSON.stringify({ providerProfile: 'qq-official', model: 'gpt-5.2@qq-official', at: 1 })],
    ]),
  });
  loadHelpers(context);
  const preferences = context.getAttachedSessionToolPreferences('codex');
  assert.equal(preferences.providerProfile, 'qq-official', 'unpinned session inherits the last global provider');
  assert.equal(preferences.inheritedProviderProfile, true, 'inheritance is flagged for scoping/fallback logic');
  assert.equal(preferences.model, 'gpt-5.2@qq-official', 'unpinned session inherits the paired model');
  assert.equal(preferences.inheritedModel, true);
  assert.equal(preferences.hasModel, false, 'inheritance does not fake an own-model patch state');
}

// —— 2. 会话自带 provider/model → 不继承 ——
{
  const context = makeContext({
    session: { id: 'session-pinned', tool: 'codex', providerProfile: 'zen', model: 'glm-5.2@zen' },
    storageEntries: new Map([
      ['lastRuntimeSelection_codex', JSON.stringify({ providerProfile: 'qq-official', model: 'gpt-5.2@qq-official', at: 1 })],
    ]),
  });
  loadHelpers(context);
  const preferences = context.getAttachedSessionToolPreferences('codex');
  assert.equal(preferences.providerProfile, 'zen', 'session-own provider wins');
  assert.ok(!preferences.inheritedProviderProfile);
  assert.equal(preferences.model, 'glm-5.2@zen', 'session-own model wins');
  assert.ok(!preferences.inheritedModel);
}

// —— 2b. 只有 provider 缺失、model 已固定 → 从 scoped model 推导 provider ——
{
  const context = makeContext({
    session: { id: 'session-mixed', tool: 'claude-bidi', model: 'sonnet@pack-a' },
    storageEntries: new Map([
      ['lastRuntimeSelection_claude-bidi', JSON.stringify({ providerProfile: 'pack-b', model: 'opus@pack-b', at: 1 })],
    ]),
  });
  loadHelpers(context);
  const preferences = context.getAttachedSessionToolPreferences('claude-bidi');
  assert.equal(preferences.providerProfile, 'pack-a', 'a scoped model supplies its own provider');
  assert.equal(preferences.model, 'sonnet@pack-a', 'existing own model is not overwritten');
  assert.ok(!preferences.inheritedProviderProfile, 'the derived provider is not a global inheritance');
}

// —— 3. 旧键迁移回退 ——
{
  const context = makeContext({
    session: { id: 'session-migrate', tool: 'codex' },
    storageEntries: new Map([
      ['selectedProvider_codex', 'zen'],
      ['selectedModel_codex', 'glm-5.2@zen'],
    ]),
  });
  loadHelpers(context);
  const inherited = context.getLastGlobalRuntimeSelection('codex');
  assert.equal(inherited.providerProfile, 'zen', 'legacy provider key migrates');
  assert.equal(inherited.model, 'glm-5.2@zen', 'legacy model key migrates');
  const preferences = context.getAttachedSessionToolPreferences('codex');
  assert.equal(preferences.providerProfile, 'zen');
}

// —— 4. 成对写入 + 旧键同步 ——
{
  const storage = new Map();
  const context = makeContext({ storageEntries: storage });
  loadHelpers(context);
  context.rememberGlobalRuntimeSelection('codex', 'qq-official', 'gpt-5.2@qq-official');
  const raw = JSON.parse(storage.get('lastRuntimeSelection_codex'));
  assert.equal(raw.providerProfile, 'qq-official');
  assert.equal(raw.model, 'gpt-5.2@qq-official');
  assert.ok(Number.isFinite(raw.at), 'record carries a timestamp');
  assert.equal(storage.get('selectedProvider_codex'), 'qq-official', 'legacy provider key stays aligned');
  assert.equal(storage.get('selectedModel_codex'), 'gpt-5.2@qq-official', 'legacy model key stays aligned');

  // 换 provider 不带 model：成对记录整体替换，不会留下上一个 provider 的 model。
  context.rememberGlobalRuntimeSelection('codex', 'zen', '');
  const next = JSON.parse(storage.get('lastRuntimeSelection_codex'));
  assert.equal(next.providerProfile, 'zen');
  assert.ok(!next.model, 'pair record must not resurrect the previous provider\'s model');
  assert.equal(storage.get('selectedProvider_codex'), 'zen');
  assert.equal(storage.get('selectedModel_codex'), undefined, 'legacy model key is cleared with the provider switch');
}

// —— 5. parseScopedModelProvider 与服务端 parseScopedCodexModel 对齐 ——
// (vm context objects live in another realm — compare serialized form)
{
  const context = makeContext({});
  loadHelpers(context);
  const asJson = (value) => JSON.stringify(value);
  assert.equal(
    asJson(context.parseScopedModelProvider('gpt-5.2@qq-official')),
    asJson({ model: 'gpt-5.2', providerId: 'qq-official' }),
  );
  assert.equal(
    asJson(context.parseScopedModelProvider('bare-model')),
    asJson({ model: 'bare-model', providerId: '' }),
  );
  assert.equal(
    asJson(context.parseScopedModelProvider('weird@pro vider')),
    asJson({ model: 'weird@pro vider', providerId: '' }),
    'provider ids outside the known shape never split',
  );
}

// —— 6. 继承的 provider 参与模型列表过滤 ——
{
  const context = makeContext({});
  loadHelpers(context);
  const models = [
    { id: 'gpt-5.2@qq-official', label: 'gpt-5.2 · QQ' },
    { id: 'glm-5.2@zen', label: 'glm-5.2 · Zen' },
  ];
  const scoped = context.filterModelsForSessionProvider('codex', models, {
    providerProfile: 'qq-official',
    inheritedProviderProfile: true,
  });
  assert.deepEqual([...scoped.map((m) => m.id)], ['gpt-5.2@qq-official'], 'inherited provider scopes the catalog the same way');
  assert.equal(scoped[0].label, 'gpt-5.2', 'provider tag suffix is stripped in the scoped sheet');

  // provider 无已发现模型且目录使用 scoped id → 明确空列表（不静默换 provider 路由）
  const empty = context.filterModelsForSessionProvider('codex', models, {
    providerProfile: 'deleted-provider',
    inheritedProviderProfile: true,
  });
  assert.equal(JSON.stringify(empty), '[]', 'an unavailable provider shows empty rather than wrong-provider models');
}

// —— 7. 新会话创建继承链（sidebar-ui createNewSessionShortcut 的解析顺序）——
{
  const sidebarSource = readFileSync(join(repoRoot, 'static', 'chat', 'sidebar-ui.js'), 'utf8');
  assert.match(
    sidebarSource,
    /getLastGlobalRuntimeSelection/,
    'new-session creation must consult the last global selection before legacy keys',
  );
  assert.ok(
    sidebarSource.indexOf('getLastGlobalRuntimeSelection') < sidebarSource.indexOf("localStorage.getItem(`selectedProvider_${tool}`)"),
    'paired last-selection wins over the legacy per-tool keys',
  );
  assert.match(
    toolingSource,
    /parseScopedModelProvider\(selectedModel\)\.providerId/,
    'model selection stores the parsed provider id rather than the helper object',
  );
  assert.match(
    toolingSource,
    /selectedModelIsInherited \? \{\} : \{ model: selectedModel \|\| "" \}/,
    'unrelated session preference patches must not pin an inherited model',
  );
  assert.match(
    toolingSource,
    /getLastGlobalRuntimeSelection\(toolId\)/,
    'model restoration must use the paired global selection',
  );
  assert.match(
    sidebarSource,
    /if \(!rememberedProvider && !rememberedModel\)/,
    'new-session creation must not mix partial session preferences with a global pair',
  );
  assert.match(
    sidebarSource,
    /if \(!rememberedProvider && !rememberedModel && typeof selectedModel === "string"\)/,
    'provider-only global selections must not absorb a stale UI model',
  );
}

console.log('test-chat-session-runtime-inheritance: all assertions passed');
