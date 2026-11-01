#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const toolingSource = readFileSync(join(repoRoot, 'static', 'chat', 'tooling.js'), 'utf8');

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
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);
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

function makeClassList() {
  const classes = new Set();
  return {
    toggle(token, force) {
      if (force) classes.add(token);
      else classes.delete(token);
      return !!force;
    },
    add(token) {
      classes.add(token);
    },
    remove(token) {
      classes.delete(token);
    },
    contains(token) {
      return classes.has(token);
    },
  };
}

function makeElement() {
  let html = '';
  return {
    children: [],
    classList: makeClassList(),
    attrs: {},
    hidden: false,
    disabled: false,
    textContent: '',
    className: '',
    set innerHTML(value) {
      html = value;
      this.children = [];
    },
    get innerHTML() {
      return html;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    addEventListener(type, listener) {
      this[`on${type}`] = listener;
    },
  };
}

function makeSelect(value, options) {
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  return {
    value,
    selectedIndex,
    disabled: false,
    style: {},
    options,
    dispatched: [],
    dispatchEvent(event) {
      this.dispatched.push(event.type);
    },
  };
}

function makeStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    dump() {
      return Object.fromEntries(data.entries());
    },
  };
}

const localStorage = makeStorage();

const context = {
  console,
  Event: class Event {
    constructor(type) {
      this.type = type;
    }
  },
  document: {
    createElement() {
      return makeElement();
    },
  },
  window: {},
  localStorage,
  t(key) {
    return {
      'tooling.defaultModel': 'default',
      'tooling.thinking': 'Thinking',
      'tooling.serviceTierStandard': 'Standard',
      'tooling.serviceTierFast': 'Fast',
      'tooling.serviceTierTitle': 'Thinking speed',
      'tooling.serviceTierAriaLabel': 'Choose thinking speed',
      'tooling.serviceTierSwitchTo': 'Switch to',
      'compose.runtime.defaultReasoning': 'Default',
      'compose.runtime.reasoningOff': 'Off',
      'compose.permission.default': 'Permissions',
      'compose.permission.mode.readOnly': 'Read-only',
      'compose.permission.mode.fullAccess': 'Full access',
      'compose.permission.mode.claudeDefault': 'Claude default',
      'compose.permission.mode.skipPermissions': 'Skip permissions',
      'compose.provider.title': 'Provider',
      'compose.provider.accountTitle': 'Account',
    }[key] || key;
  },
  canChangeRuntimeSelectionFromUi() {
    return true;
  },
  updateThinkingUI() {},
  syncComposerModeUi() {},
  queueRuntimeSelectionSync() {},
  persistCurrentSessionToolPreferences() {},
  ADD_MORE_TOOL_VALUE: '__add_more__',
  selectedTool: 'codex',
  selectedModel: 'gpt-5.5',
  selectedEffort: 'Extra High',
  selectedPermissionMode: 'bypass-approvals-and-sandbox',
  selectedServiceTier: 'standard',
  currentToolServiceTiers: ['standard', 'fast'],
  currentToolReasoningKind: 'enum',
  currentToolReasoningLabel: 'Reasoning',
  currentToolEffortLevels: ['Low', 'Medium', 'High', 'Extra High'],
  thinkingEnabled: true,
  toolsList: [
    {
      id: 'codex',
      name: 'Codex',
      providerCapabilities: {
        defaultPermissionMode: 'bypass-approvals-and-sandbox',
        permissionModes: [
          { id: 'untrusted-read-only', label: 'untrusted / read-only' },
          { id: 'untrusted-workspace-write', label: 'untrusted / workspace-write' },
          { id: 'untrusted-danger-full-access', label: 'untrusted / danger-full-access' },
          { id: 'on-request-read-only', label: 'on-request / read-only' },
          { id: 'on-request-workspace-write', label: 'on-request / workspace-write' },
          { id: 'on-request-danger-full-access', label: 'on-request / danger-full-access' },
          { id: 'on-failure-read-only', label: 'on-failure / read-only (deprecated)' },
          { id: 'on-failure-workspace-write', label: 'on-failure / workspace-write (deprecated)' },
          { id: 'on-failure-danger-full-access', label: 'on-failure / danger-full-access (deprecated)' },
          { id: 'never-read-only', label: 'never / read-only' },
          { id: 'never-workspace-write', label: 'never / workspace-write' },
          { id: 'never-danger-full-access', label: 'never / danger-full-access' },
          { id: 'bypass-approvals-and-sandbox', label: 'bypass approvals+sandbox' },
        ],
      },
    },
    {
      id: 'claude',
      name: 'Claude Code',
      runtimeFamily: 'claude-stream-json-bidi',
      providerCapabilities: {
        defaultPermissionMode: 'bypassPermissions',
        permissionModes: [
          { id: 'default', label: 'default' },
          { id: 'acceptEdits', label: 'acceptEdits' },
          { id: 'auto', label: 'auto' },
          { id: 'dontAsk', label: 'dontAsk' },
          { id: 'plan', label: 'plan' },
          { id: 'bypassPermissions', label: 'bypassPermissions' },
        ],
      },
    },
  ],
  inlineToolSelect: makeSelect('codex', [
    { value: 'codex', textContent: 'Codex' },
    { value: 'claude', textContent: 'Claude Code' },
    { value: '__add_more__', textContent: '+ Add more...' },
  ]),
  inlineModelSelect: makeSelect('gpt-5.5', [
    { value: '', textContent: 'default' },
    { value: 'gpt-5.5', textContent: 'GPT-5.5' },
    { value: 'speed', textContent: 'Speed' },
  ]),
  effortSelect: makeSelect('Extra High', [
    { value: 'Low', textContent: 'Low' },
    { value: 'Medium', textContent: 'Medium' },
    { value: 'High', textContent: 'High' },
    { value: 'Extra High', textContent: 'Extra High' },
  ]),
  serviceTierSelect: makeSelect('standard', [
    { value: 'standard', textContent: 'Standard' },
    { value: 'fast', textContent: 'Fast' },
  ]),
  thinkingToggle: { disabled: false },
  composerRuntimeBtn: makeElement(),
  composerRuntimeLabel: makeElement(),
  composerRuntimeMenu: makeElement(),
  composerRuntimeToolView: makeElement(),
  composerRuntimeProviderView: makeElement(),
  composerRuntimeProviderTitle: makeElement(),
  composerRuntimeModelView: makeElement(),
  composerRuntimePermissionView: makeElement(),
  composerRuntimeToolOptions: makeElement(),
  composerRuntimeProviderOptions: makeElement(),
  composerRuntimeProviderStatus: makeElement(),
  composerRuntimeProviderBackBtn: makeElement(),
  composerRuntimeSpeedBtn: makeElement(),
  composerRuntimeSpeedIcon: makeElement(),
  composerRuntimeSpeedPanel: makeElement(),
  composerRuntimeSpeedToggle: makeElement(),
  composerRuntimeSpeedSelectWrap: makeElement(),
  composerRuntimeSpeedSelect: Object.assign(makeElement(), { value: 'standard' }),
  composerRuntimeEffortValue: makeElement(),
  composerRuntimeEffortRange: Object.assign(makeElement(), { value: '3', max: '0' }),
  composerRuntimeModelBackBtn: makeElement(),
  composerRuntimeModelOptions: makeElement(),
  composerRuntimePermissionBtn: makeElement(),
  composerRuntimePermissionLabel: makeElement(),
  composerRuntimePermissionBackBtn: makeElement(),
  composerRuntimePermissionOptions: makeElement(),
  composerPermissionBtn: makeElement(),
  composerPermissionLabel: makeElement(),
  composerPermissionMenu: makeElement(),
  composerPermissionOptions: makeElement(),
  inlineAgentSelect: makeSelect('', [
    { value: '', textContent: 'Chat' },
    { value: '__plan', textContent: 'Plan' },
  ]),
};
context.composerRuntimeSpeedSelect.parentElement = context.composerRuntimeSpeedSelectWrap;
context.globalThis = context;

const functionNames = [
  'getSelectDisplayLabel',
  'normalizeComposerRuntimeMenuView',
  'setComposerRuntimeView',
  'getRuntimeAddMoreValue',
  'syncCustomSelectBridge',
  'setNativeSelectValue',
  'dispatchNativeChange',
  'getComposerRuntimeModelLabel',
  'getComposerRuntimeReasoningLabel',
  'getComposerRuntimeButtonLabel',
  'isComposerPlanMode',
  'getComposerRuntimeToolOptions',
  'getComposerRuntimeModelOptions',
  'getComposerRuntimeProviderApp',
  'getSelectedToolDefinition',
  'normalizePermissionModeId',
  'getPermissionModeI18nKey',
  'getPermissionModeDisplayLabel',
  'getSelectedToolProviderCapabilities',
  'getComposerPermissionModes',
  'getComposerDefaultPermissionMode',
  'getComposerEffectivePermissionMode',
  'canUseComposerPermissionControls',
  'resolveComposerPermissionMode',
  'applyCurrentToolPermissionModeUi',
  'getComposerPermissionButtonLabel',
  'scrollActiveComposerRuntimeOptionIntoView',
  'renderComposerPermissionOptionList',
  'createComposerRuntimeOption',
  'renderComposerRuntimeToolOptions',
  'renderComposerRuntimeModelOptions',
  'renderComposerPermissionOptions',
  'renderComposerRuntimePermissionOptions',
  'syncComposerPermissionUi',
  'syncComposerRuntimeUi',
  'setComposerRuntimeMenuOpen',
  'setComposerPermissionMenuOpen',
  'setComposerRuntimeReasoning',
  'setComposerRuntimeModel',
  'setComposerPermissionMode',
];

vm.runInNewContext(
  [
    'let composerRuntimeMenuOpen = false;',
    'let composerRuntimeMenuView = "tools";',
    'let composerRuntimeTransitionDirection = "none";',
    'let composerRuntimeProviderLoadGeneration = 0;',
    'let composerRuntimeSpeedPanelOpen = false;',
    'let composerRuntimeMenuBackEntryId = null;',
    'let composerPermissionMenuOpen = false;',
    'let composerPermissionMenuBackEntryId = null;',
    ...['syncComposerRuntimeMenuBackEntry', 'syncComposerPermissionMenuBackEntry'].map((name) => extractFunctionSource(toolingSource, name)),
    ...[
      extractFunctionSource(toolingSource, 'serviceTierLabel'),
      extractFunctionSource(toolingSource, 'syncComposerRuntimeSpeedIcon'),
      extractFunctionSource(toolingSource, 'syncComposerRuntimeEffortUi'),
      extractFunctionSource(toolingSource, 'syncComposerRuntimeSpeedUi'),
      extractFunctionSource(toolingSource, 'setSelectedServiceTier'),
      extractFunctionSource(toolingSource, 'setSelectedEffort'),
      ...functionNames.map((name) => extractFunctionSource(toolingSource, name)),
    ],
    'globalThis.syncComposerRuntimeUi = syncComposerRuntimeUi;',
    'globalThis.setComposerRuntimeMenuOpen = setComposerRuntimeMenuOpen;',
    'globalThis.setComposerPermissionMenuOpen = setComposerPermissionMenuOpen;',
    'globalThis.setComposerRuntimeReasoning = setComposerRuntimeReasoning;',
    'globalThis.setComposerRuntimeModel = setComposerRuntimeModel;',
    'globalThis.setComposerPermissionMode = setComposerPermissionMode;',
    'globalThis.getSelectedPermissionModeForTest = () => selectedPermissionMode;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/tooling.js' },
);

context.syncComposerRuntimeUi();

assert.equal(context.composerRuntimeLabel.textContent, 'GPT-5.5', 'runtime pill should summarize the model without reasoning effort');
assert.equal(context.composerRuntimeSpeedBtn.hidden, false, 'speed entry should appear when the model exposes multiple service tiers');
assert.equal(context.composerRuntimeSpeedBtn.disabled, false, 'speed entry should be enabled when runtime selection is available');
assert.equal(context.composerRuntimeSpeedSelectWrap.hidden, false, 'speed selector should be visible when the model exposes fast service tier');
assert.equal(context.composerRuntimeSpeedPanel.classList.contains('has-speed-choice'), true, 'speed panel should mark when speed choices are available');
assert.equal(context.composerRuntimeSpeedSelect.value, 'standard', 'speed selector should default to standard');
assert.equal(context.composerRuntimeSpeedToggle.hidden, false, 'speed toggle should be visible when fast service tier is available');
assert.equal(context.composerRuntimeSpeedToggle.attrs['aria-pressed'], 'false', 'standard mode should expose an unpressed speed toggle');
assert.equal(context.composerRuntimeSpeedToggle.classList.contains('is-fast'), false, 'standard mode should use the outline bolt');
assert.equal(context.composerRuntimeEffortValue.textContent, 'Extra High', 'effort slider should reflect the selected model effort');
assert.equal(context.composerRuntimeEffortRange.value, '3', 'effort slider should map to the selected effort level');
assert.equal(context.composerRuntimeEffortRange.max, '3', 'effort slider should use the selected model effort levels');
assert.equal(context.composerRuntimeSpeedPanel.hidden, true, 'speed panel should start collapsed');
context.setSelectedServiceTier('fast', { persist: false });
assert.equal(context.composerRuntimeSpeedSelect.value, 'fast', 'speed selection should update the speed bar');
assert.equal(context.composerRuntimeSpeedToggle.attrs['aria-pressed'], 'true', 'fast mode should expose a pressed speed toggle');
assert.equal(context.composerRuntimeSpeedToggle.classList.contains('is-fast'), true, 'fast mode should use the solid bolt');
context.setSelectedEffort('Medium', { persist: false });
assert.equal(context.composerRuntimeEffortValue.textContent, 'Medium', 'effort selection should update the visible effort label');
assert.equal(
  context.composerRuntimeEffortValue.classList.contains('is-switching'),
  true,
  'effort selection should trigger the visible label transition state',
);
assert.equal(context.composerRuntimeEffortRange.value, '1', 'effort selection should move the drag thumb');
context.currentToolServiceTiers = ['standard'];
context.syncComposerRuntimeUi();
assert.equal(context.composerRuntimeSpeedBtn.hidden, false, 'speed entry should remain visible for standard-only providers');
assert.equal(context.composerRuntimeSpeedSelectWrap.hidden, true, 'standard-only providers should hide the speed selector');
assert.equal(context.composerRuntimeSpeedSelect.disabled, true, 'standard-only providers should disable the speed selector');
assert.equal(context.composerRuntimeSpeedPanel.classList.contains('has-speed-choice'), false, 'standard-only providers should use the compact speed panel');
context.currentToolServiceTiers = ['standard', 'fast'];
context.syncComposerRuntimeUi();
assert.equal(context.composerRuntimeSpeedSelectWrap.hidden, false, 'speed selector should return when fast service tier is available');
assert.equal(context.composerRuntimeMenu.hidden, true, 'runtime menu should start closed');
assert.equal(
  context.composerPermissionLabel.textContent,
  'bypass approvals+sandbox',
  'permission pill should summarize the current permission mode',
);
assert.equal(context.composerPermissionBtn.hidden, true, 'standalone permission control should stay hidden');
assert.equal(
  context.composerRuntimePermissionLabel.textContent,
  'bypass approvals+sandbox',
  'runtime settings permission row should summarize the current permission mode',
);
assert.equal(context.composerRuntimePermissionBtn.hidden, true, 'runtime settings permission row should stay hidden');
assert.deepEqual(
  context.composerRuntimeToolOptions.children.map((child) => child.children[0].textContent),
  ['Codex', 'Claude Code'],
  'runtime menu first level should list tools and omit add-more pseudo options',
);
assert.deepEqual(
  context.composerRuntimeToolOptions.children.map((child) => child.children.at(-1).className),
  [
    'composer-runtime-option-chevron composer-runtime-option-chevron--right',
    'composer-runtime-option-chevron composer-runtime-option-chevron--right',
  ],
  'runtime tool choices should indicate that they open the next level',
);
assert.equal(
  context.composerRuntimeToolOptions.children.some((child) => child.children.some((node) => node.className === 'composer-runtime-option-check')),
  false,
  'runtime selections should not render checkmark icons',
);
context.toolsList.push({ id: 'agy', name: 'agy', runtimeFamily: 'agy-cli' });
assert.equal(context.getComposerRuntimeProviderApp('codex'), 'codex', 'Codex should expose the Provider level');
assert.equal(context.getComposerRuntimeProviderApp('agy'), 'agy', 'agy should expose the account level');
context.selectedTool = 'agy';
context.syncComposerRuntimeUi();
assert.equal(context.composerRuntimeProviderTitle.textContent, 'Account', 'agy account level should use account copy');
context.selectedTool = 'codex';
context.syncComposerRuntimeUi();
assert.equal(context.composerRuntimeProviderTitle.textContent, 'Provider', 'Codex should keep Provider copy');

context.setComposerRuntimeMenuOpen(true);
assert.equal(context.composerRuntimeMenu.hidden, false, 'runtime menu should open on demand');
assert.equal(context.composerPermissionMenu.hidden, true, 'opening runtime menu should close the permission menu');
assert.equal(context.composerRuntimeBtn.attrs['aria-expanded'], 'true', 'runtime button should expose open state');
assert.equal(context.composerRuntimeToolView.classList.contains('active'), true, 'runtime menu should open to the tool picker');

context.setComposerRuntimeMenuOpen(true, { view: 'providers' });
assert.equal(context.composerRuntimeProviderView.classList.contains('active'), true, 'Provider view should replace the tool picker');
assert.equal(context.composerRuntimeProviderView.classList.contains('is-enter-forward'), true, 'Provider view should slide in as the next level');

context.setComposerRuntimeMenuOpen(true, { view: 'models' });
assert.equal(context.composerRuntimeProviderView.classList.contains('active'), false, 'model picker should replace the Provider view');
assert.equal(context.composerRuntimeModelView.classList.contains('active'), true, 'model picker should be its own runtime menu level');
assert.equal(context.composerRuntimeModelOptions.hidden, false, 'model options should be visible only inside the model level');
assert.deepEqual(
  context.composerRuntimeModelOptions.children.map((child) => child.children[0].textContent),
  ['default', 'GPT-5.5', 'Speed'],
  'model level should render model options',
);

context.setComposerRuntimeMenuOpen(true, { view: 'permissions' });
assert.equal(context.composerRuntimeModelView.classList.contains('active'), true, 'permission picker should fall back to the model view');
assert.equal(context.composerRuntimePermissionView.classList.contains('active'), false, 'permission picker should not be reachable');
assert.equal(context.composerRuntimePermissionOptions.hidden, true, 'runtime permission options should stay hidden');
assert.deepEqual(context.composerRuntimePermissionOptions.children, [], 'runtime permission options should not render');

context.setComposerRuntimeReasoning('Medium');
assert.equal(context.effortSelect.value, 'Medium', 'reasoning option should write back to the native effort select');
assert.deepEqual(context.effortSelect.dispatched, ['change'], 'reasoning option should notify the existing effort handler');

context.setComposerRuntimeModel('speed');
assert.equal(context.inlineModelSelect.value, 'speed', 'model option should write back to the native model select');
assert.deepEqual(context.inlineModelSelect.dispatched, ['change'], 'model option should notify the existing model handler');
assert.equal(context.composerRuntimeMenu.hidden, true, 'choosing a model should close the runtime menu');

context.setComposerPermissionMenuOpen(true);
assert.equal(context.composerPermissionMenu.hidden, true, 'standalone permission menu should stay hidden');
assert.equal(context.composerRuntimeMenu.hidden, true, 'opening permission menu should close the runtime menu');
assert.deepEqual(context.composerPermissionOptions.children, [], 'standalone permission options should not render');

context.setComposerPermissionMode('never-read-only');
assert.equal(context.getSelectedPermissionModeForTest(), 'bypass-approvals-and-sandbox', 'permission mode should remain fixed at the highest Codex level');
assert.equal(context.localStorage.dump().selectedPermissionMode_codex, undefined, 'permission option should not persist outside the current session');
assert.equal(context.composerPermissionLabel.textContent, 'bypass approvals+sandbox', 'permission label should remain at the highest Codex level');
assert.equal(context.composerRuntimePermissionLabel.textContent, 'bypass approvals+sandbox', 'runtime permission label should remain at the highest Codex level');

context.applyCurrentToolPermissionModeUi({
  sessionPreferences: { hasPermissionMode: true, permissionMode: 'never-workspace-write' },
});
assert.equal(context.getSelectedPermissionModeForTest(), 'bypass-approvals-and-sandbox', 'a session should not restore an older lower permission mode');
context.applyCurrentToolPermissionModeUi({ sessionPreferences: null });
assert.equal(
  context.getSelectedPermissionModeForTest(),
  'bypass-approvals-and-sandbox',
  'a session without a saved permission should use the provider default instead of inheriting another session',
);

context.selectedTool = 'claude';
context.inlineAgentSelect.value = '__plan';
context.applyCurrentToolPermissionModeUi({ sessionPreferences: null });
assert.equal(context.getSelectedPermissionModeForTest(), 'plan', 'Claude Plan mode should continue to use plan permission');

console.log('test-chat-composer-runtime-menu: ok');
