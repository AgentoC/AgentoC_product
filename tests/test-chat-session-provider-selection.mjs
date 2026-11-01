#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const toolingSource = readFileSync(join(repoRoot, 'static', 'chat', 'tooling.js'), 'utf8');
const composeSource = readFileSync(join(repoRoot, 'static', 'chat', 'compose.js'), 'utf8');
const realtimeSource = readFileSync(join(repoRoot, 'static', 'chat', 'realtime.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  let start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  if (source.slice(Math.max(0, start - 6), start) === 'async ') {
    start -= 6;
  }
  let parenDepth = 0;
  let bodyStart = -1;
  for (let i = source.indexOf('(', start); i < source.length; i += 1) {
    if (source[i] === '(') parenDepth += 1;
    else if (source[i] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        bodyStart = source.indexOf('{', i);
        break;
      }
    }
  }
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

const storage = new Map([['preferredTool', 'codex']]);
const fetches = [];
const persisted = [];
const context = {
  console,
  currentSessionId: 'session-a',
  selectedTool: 'codex',
  preferredTool: 'codex',
  selectedModel: '',
  selectedEffort: '',
  thinkingEnabled: false,
  currentToolReasoningKind: 'none',
  lastSyncedRuntimeSelectionPayload: '',
  runtimeSelectionSyncPromise: Promise.resolve(),
  localStorage: {
    getItem(key) { return storage.get(key) || null; },
    setItem(key, value) { storage.set(key, String(value)); },
  },
  canChangeRuntimeSelectionFromUi() { return true; },
  fetchJsonOrRedirect(url, options) {
    fetches.push({ url, options });
    return Promise.resolve({});
  },
  ADD_MORE_TOOL_VALUE: '__add_more__',
  markCurrentSessionRuntimePreferencesEdited() {},
  loadModelsForCurrentTool() { return Promise.resolve(); },
  // This context has no session object attached, so preferences resolution
  // (including the inherit-last-global-selection path) resolves to nothing.
  getAttachedSessionToolPreferences() { return null; },
  rememberGlobalRuntimeSelection() {},
  syncComposerModeUi() {},
  persistCurrentSessionToolPreferences() {
    persisted.push({ sessionId: context.currentSessionId, tool: context.selectedTool });
    return Promise.resolve(true);
  },
  window: { syncGoalMenuVisibility() {} },
};
context.globalThis = context;

vm.runInNewContext([
  extractFunctionSource(toolingSource, 'buildRuntimeSelectionPayload'),
  extractFunctionSource(toolingSource, 'queueRuntimeSelectionSync'),
  extractFunctionSource(toolingSource, 'applyInlineToolSelection'),
  'globalThis.queueRuntimeSelectionSync = queueRuntimeSelectionSync;',
  'globalThis.applyInlineToolSelection = applyInlineToolSelection;',
].join('\n\n'), context, { filename: 'session-provider-selection.js' });

context.queueRuntimeSelectionSync();
await context.runtimeSelectionSyncPromise;
assert.equal(fetches.length, 0, 'an attached session must not rewrite the global runtime default');

await context.applyInlineToolSelection('claude-bidi');
assert.equal(context.selectedTool, 'claude-bidi', 'the attached composer should adopt the selected Provider');
assert.equal(context.preferredTool, 'codex', 'the future-session default must remain unchanged');
assert.equal(storage.get('preferredTool'), 'codex', 'browser default cache must remain unchanged');
assert.deepEqual(persisted, [{ sessionId: 'session-a', tool: 'claude-bidi' }]);
assert.equal(fetches.length, 0, 'session Provider persistence must not write the global selection endpoint');

context.currentSessionId = '';
await context.applyInlineToolSelection('claude-bidi');
await context.runtimeSelectionSyncPromise;
assert.equal(context.preferredTool, 'claude-bidi', 'selection without an attached session may set the future-session default');
assert.equal(storage.get('preferredTool'), 'claude-bidi');
assert.equal(fetches.at(-1)?.url, '/api/runtime-selection');

assert.doesNotMatch(
  composeSource,
  /if \(sendTool\) msg\.tool = sendTool/,
  'ordinary composer sends must not attach a per-message Provider override',
);
const ordinarySendBranch = realtimeSource.slice(
  realtimeSource.indexOf('case "send":'),
  realtimeSource.indexOf('case "plan_action":'),
);
assert.doesNotMatch(
  ordinarySendBranch,
  /formData\.set\("tool", msg\.tool\)|\{ tool: msg\.tool \}/,
  'ordinary JSON and multipart requests must not serialize a Provider override',
);
const planActionBranch = realtimeSource.slice(
  realtimeSource.indexOf('case "plan_action":'),
  realtimeSource.indexOf('case "runtime_approval":'),
);
assert.doesNotMatch(
  planActionBranch,
  /\{ tool: msg\.tool \}/,
  'plan actions must use the Provider persisted on the session',
);

const preferencePatchRequests = [];
const dispatchContext = {
  console,
  currentSessionId: 'session-a',
  fetchJsonOrRedirect(url, options) {
    preferencePatchRequests.push({ url, options });
    return Promise.resolve({ session: { id: 'session-a', tool: 'claude-bidi' } });
  },
  upsertSession(session) { return session; },
  renderSessionList() {},
  applyAttachedSessionState() {},
};
dispatchContext.globalThis = dispatchContext;
vm.runInNewContext([
  extractFunctionSource(realtimeSource, 'dispatchAction'),
  'globalThis.dispatchAction = dispatchAction;',
].join('\n\n'), dispatchContext, { filename: 'session-provider-dispatch.js' });

const preferencePersisted = await dispatchContext.dispatchAction({
  action: 'session_preferences',
  sessionId: 'session-a',
  tool: 'claude-bidi',
});
assert.equal(preferencePersisted, true, 'successful session Provider persistence must report success');
assert.equal(preferencePatchRequests.length, 1);
assert.equal(preferencePatchRequests[0]?.url, '/api/sessions/session-a');
assert.equal(preferencePatchRequests[0]?.options?.method, 'PATCH');
assert.equal(JSON.parse(preferencePatchRequests[0]?.options?.body || '{}').tool, 'claude-bidi');

const persistenceWarnings = [];
const failureContext = {
  console: { ...console, warn(...args) { persistenceWarnings.push(args); } },
  currentSessionId: 'session-a',
  selectedTool: 'claude-bidi',
  selectedModel: '',
  selectedEffort: '',
  selectedPermissionMode: '',
  selectedModelIsInherited: true,
  currentToolReasoningKind: 'none',
  thinkingEnabled: false,
  canChangeRuntimeSelectionFromUi() { return true; },
  isComposerPlanMode() { return false; },
  dispatchAction() { return Promise.resolve(false); },
};
failureContext.globalThis = failureContext;
vm.runInNewContext([
  'let sessionToolPreferencesPersistPromise = Promise.resolve();',
  extractFunctionSource(toolingSource, 'waitForPendingSessionToolPreferencesPersist'),
  extractFunctionSource(toolingSource, 'persistCurrentSessionToolPreferences'),
  'globalThis.waitForPendingSessionToolPreferencesPersist = waitForPendingSessionToolPreferencesPersist;',
  'globalThis.persistCurrentSessionToolPreferences = persistCurrentSessionToolPreferences;',
].join('\n\n'), failureContext, { filename: 'session-provider-persistence-failure.js' });

const failedPersistence = failureContext.persistCurrentSessionToolPreferences();
await assert.rejects(failedPersistence, /Failed to persist session runtime preferences/);
assert.equal(persistenceWarnings.length, 1, 'background persistence failure must be observed');
await assert.rejects(
  failureContext.waitForPendingSessionToolPreferencesPersist(),
  /Failed to persist session runtime preferences/,
  'the next send must still observe the failed session Provider save',
);

const inheritedModelPayloads = [];
const inheritedModelContext = {
  console,
  currentSessionId: 'session-inherited-model',
  selectedTool: 'codex',
  selectedModel: 'gpt-5.2@qq-official',
  selectedModelIsInherited: true,
  selectedEffort: 'medium',
  selectedServiceTier: 'standard',
  selectedPermissionMode: '',
  currentToolReasoningKind: 'enum',
  thinkingEnabled: false,
  isComposerPlanMode() { return false; },
  canChangeRuntimeSelectionFromUi() { return true; },
  dispatchAction(payload) {
    inheritedModelPayloads.push(payload);
    return Promise.resolve(true);
  },
};
inheritedModelContext.globalThis = inheritedModelContext;
vm.runInNewContext([
  'let sessionToolPreferencesPersistPromise = Promise.resolve();',
  extractFunctionSource(toolingSource, 'persistCurrentSessionToolPreferences'),
  'globalThis.persistCurrentSessionToolPreferences = persistCurrentSessionToolPreferences;',
].join('\n\n'), inheritedModelContext, { filename: 'session-provider-inherited-model-persistence.js' });

await inheritedModelContext.persistCurrentSessionToolPreferences();
assert.equal(inheritedModelPayloads.length, 1);
assert.equal(
  Object.prototype.hasOwnProperty.call(inheritedModelPayloads[0], 'model'),
  false,
  'an unrelated preference patch must leave an inherited model unpinned',
);

console.log('test-chat-session-provider-selection: ok');
