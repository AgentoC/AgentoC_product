#!/usr/bin/env node
// Phase 4 continuous-action folding: consecutive same-kind completed
// operations collapse into a "N actions completed" card. Mirrors the
// vm-extraction pattern of test-chat-operation-rendering.mjs.
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
  assert.notEqual(start, -1, `${functionName} should exist in ui.js`);
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

function classNames(element) {
  return new Set(String(element.className || '').split(/\s+/).filter(Boolean));
}

function matchesSelector(element, selector) {
  if (selector.startsWith('.')) return classNames(element).has(selector.slice(1));
  if (selector === '[data-operation-id]') return !!String(element.dataset?.operationId || '');
  return false;
}

function makeElement(tagName = 'div') {
  const listeners = new Map();
  const element = {
    tagName: String(tagName).toUpperCase(),
    className: '',
    dataset: {},
    children: [],
    parentNode: null,
    hidden: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    title: '',
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    replaceChildren(...children) {
      this.children = [];
      for (const child of children) this.appendChild(child);
    },
    remove() {
      if (!this.parentNode) return;
      const index = this.parentNode.children.indexOf(this);
      if (index !== -1) this.parentNode.children.splice(index, 1);
      this.parentNode = null;
    },
    get lastElementChild() {
      return this.children.length ? this.children[this.children.length - 1] : null;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    click() {
      listeners.get('click')?.({ currentTarget: this });
    },
    setAttribute(name, value) {
      this[name] = String(value);
    },
    querySelector(selector) {
      for (const child of this.children) {
        if (matchesSelector(child, selector)) return child;
        const nested = child.querySelector?.(selector);
        if (nested) return nested;
      }
      return null;
    },
    querySelectorAll(selector) {
      const matches = [];
      for (const child of this.children) {
        if (matchesSelector(child, selector)) matches.push(child);
        matches.push(...(child.querySelectorAll?.(selector) || []));
      }
      return matches;
    },
  };
  element.classList = {
    contains(name) {
      return classNames(element).has(name);
    },
    add(name) {
      const names = classNames(element);
      names.add(name);
      element.className = [...names].join(' ');
    },
    remove(name) {
      const names = classNames(element);
      names.delete(name);
      element.className = [...names].join(' ');
    },
    toggle(name, force) {
      const names = classNames(element);
      const enabled = typeof force === 'boolean' ? force : !names.has(name);
      if (enabled) names.add(name);
      else names.delete(name);
      element.className = [...names].join(' ');
      return enabled;
    },
  };
  return element;
}

const translations = {
  'activity.label.command': 'Localized command',
  'activity.label.working': 'Working',
  'activity.fold.nActions': ({ count }) => `${count} actions completed`,
  'operation.state.completed': 'Completed',
  'operation.state.failed': 'Failed',
  'operation.state.declined': 'Declined',
  'operation.state.interrupted': 'Interrupted',
  'operation.state.waiting_approval': 'Waiting for approval',
  'operation.output.omitted': ({ count }) => `${count} lines omitted`,
  'operation.files.changed': ({ count }) => `${count} files changed`,
  'operation.exitCode': ({ code }) => `exit ${code}`,
};

const context = {
  console,
  Map,
  Set,
  Date,
  document: { createElement: makeElement },
  renderedEventState: {
    operationNodesById: new Map(),
    operationSnapshotsById: new Map(),
    expandedOperationIds: new Set(),
  },
  t(key, vars = {}) {
    const value = translations[key];
    return typeof value === 'function' ? value(vars) : (value || key);
  },
  renderUiIcon(name) {
    return `<svg data-icon="${name}"></svg>`;
  },
  async hydrateLazyNodes() {},
};
context.globalThis = context;

const functionNames = [
  'ensureOperationRenderState',
  'getOperationEventId',
  'normalizeOperationState',
  'getOperationLifecycle',
  'parseActivityTimestamp',
  'formatActivityElapsed',
  'getOperationStateLabel',
  'getOperationActivitySummary',
  'getOperationElapsedMs',
  'buildOperationPreviewLines',
  'setOperationExpanded',
  'createOperationBody',
  'renderOperationNodeContent',
  'getOperationDisplayKind',
  'getOperationNodeKind',
  'findFoldContainer',
  'setFoldCountLabel',
  'toggleFoldExpanded',
  'createFoldContainer',
  'appendOperationNode',
  'refreshFoldCountForNode',
  'updateOperationNode',
  'renderOperationInto',
  'getExpandedOperationIds',
  'rebuildRenderedOperationIndexes',
];
vm.runInNewContext(
  [
    ...functionNames.map((name) => extractFunctionSource(uiSource, name)),
    ...functionNames.map((name) => `globalThis.${name} = ${name};`),
  ].join('\n\n'),
  context,
  { filename: 'static/chat/ui.js' },
);

function resetState() {
  context.renderedEventState.operationNodesById = new Map();
  context.renderedEventState.operationSnapshotsById = new Map();
  context.renderedEventState.expandedOperationIds = new Set();
}

function op(overrides) {
  return {
    type: 'operation',
    operationId: `operation:${overrides.id}`,
    kind: overrides.kind || 'command',
    state: overrides.state || 'completed',
    detail: overrides.detail || 'cmd',
    ...overrides,
  };
}

// 1) two consecutive same-kind completed ops fold into one "2 actions completed" card
resetState();
const container = makeElement('div');
context.renderOperationInto(container, op({ id: 'c1', kind: 'command', state: 'completed' }));
context.renderOperationInto(container, op({ id: 'c2', kind: 'command', state: 'completed' }));
assert.equal(container.children.length, 1, 'two completed same-kind ops should fold into one card');
const fold = container.children[0];
assert.equal(classNames(fold).has('live-operation-fold'), true, 'fold container should be present');
assert.equal(fold.dataset.foldKind, 'command', 'fold should carry the folded kind');
assert.equal(fold.querySelector('.live-operation-fold__count')?.textContent, '2 actions completed');
assert.equal(fold.querySelectorAll('.live-operation-row').length, 2, 'both rows stay inside the fold body');
assert.equal(fold.querySelector('.live-operation-fold__body').hidden, true, 'fold should start collapsed');

// 2) a third consecutive same-kind completed op bumps the count
context.renderOperationInto(container, op({ id: 'c3', kind: 'command', state: 'completed' }));
assert.equal(fold.querySelector('.live-operation-fold__count')?.textContent, '3 actions completed');
assert.equal(container.children.length, 1, 'third same-kind completed op keeps the single fold card');
assert.equal(fold.querySelectorAll('.live-operation-row').length, 3);

// 3) an intervening different-kind completed op breaks the fold
const readOp = context.renderOperationInto(container, op({ id: 'r1', kind: 'read', state: 'completed' }));
assert.equal(container.children.length, 2, 'different kind appends as a plain row after the fold');
assert.equal(classNames(container.children[1]).has('live-operation-row'), true);
assert.equal(readOp, container.children[1], 'the different-kind node is the appended plain row');

// 4) a failed/declined op never folds
resetState();
const failedContainer = makeElement('div');
context.renderOperationInto(failedContainer, op({ id: 'f1', kind: 'command', state: 'failed', exitCode: 1 }));
context.renderOperationInto(failedContainer, op({ id: 'f2', kind: 'command', state: 'completed' }));
assert.equal(failedContainer.children.length, 2, 'a failed op must not fold with a completed one');

// 5) a single completed op renders without a fold wrapper
resetState();
const singleContainer = makeElement('div');
context.renderOperationInto(singleContainer, op({ id: 's1', kind: 'command', state: 'completed' }));
assert.equal(singleContainer.children.length, 1);
assert.equal(classNames(singleContainer.children[0]).has('live-operation-fold'), false, 'single op has no fold wrapper');

// 6) running -> completed in-place update reuses the node; a following same-kind
//    completed op then folds it in
resetState();
const updateContainer = makeElement('div');
context.renderOperationInto(updateContainer, op({ id: 'u1', kind: 'command', state: 'running' }));
assert.equal(updateContainer.children.length, 1);
const runningNode = updateContainer.children[0];
assert.equal(classNames(runningNode).has('live-operation-row'), true);
context.updateOperationNode(op({ id: 'u1', kind: 'command', state: 'completed' }));
assert.equal(updateContainer.children[0], runningNode, 'in-place update must reuse the original node');
assert.equal(classNames(runningNode).has('state-completed'), true);
context.renderOperationInto(updateContainer, op({ id: 'u2', kind: 'command', state: 'completed' }));
assert.equal(updateContainer.children.length, 1, 'now-completed row folds with the next same-kind completed op');
assert.equal(classNames(updateContainer.children[0]).has('live-operation-fold'), true);
assert.equal(
  updateContainer.children[0].querySelector('.live-operation-fold__count')?.textContent,
  '2 actions completed',
);

// 7) fold summary toggles the body
const toggledFold = container.children[0];
toggledFold.querySelector('.live-operation-fold__summary')?.click();
assert.equal(toggledFold.classList.contains('is-expanded'), true, 'clicking the fold summary expands it');
assert.equal(toggledFold.querySelector('.live-operation-fold__body')?.hidden, false);
toggledFold.querySelector('.live-operation-fold__summary')?.click();
assert.equal(toggledFold.classList.contains('is-expanded'), false, 'clicking again collapses it');
assert.equal(toggledFold.querySelector('.live-operation-fold__body')?.hidden, true);

// 8) snapshot indexes still cover rows nested inside folds
resetState();
const indexContainer = makeElement('div');
context.renderOperationInto(indexContainer, op({ id: 'i1', kind: 'command', state: 'completed' }));
context.renderOperationInto(indexContainer, op({ id: 'i2', kind: 'command', state: 'completed' }));
context.rebuildRenderedOperationIndexes(indexContainer, [
  op({ id: 'i1', kind: 'command', state: 'completed' }),
  op({ id: 'i2', kind: 'command', state: 'completed' }),
]);
assert.equal(context.renderedEventState.operationNodesById.size, 2, 'rows inside a fold stay in the operation index');

console.log('test-chat-operation-folding: ok');
