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
  assert.notEqual(start, -1, `${functionName} should exist in ui.js`);
  const paramsStart = source.indexOf('(', start);
  assert.notEqual(paramsStart, -1, `${functionName} should have parameters`);
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
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

function makeElement(tagName = 'div') {
  return {
    tagName: String(tagName || 'div').toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    dataset: {},
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };
}

const renderReasoningIntoSource = extractFunctionSource(uiSource, 'renderReasoningInto');

const markdownCalls = [];
const lazyCalls = [];
const hydrateCalls = [];
const context = {
  console,
  document: {
    createElement(tagName) {
      return makeElement(tagName);
    },
  },
  renderMarkdownIntoNode(node, markdown) {
    markdownCalls.push({ node, markdown });
    node.innerHTML = `<p>${markdown}</p>`;
    return true;
  },
  markLazyEventBodyNode(node, evt, options = {}) {
    lazyCalls.push({ node, evt, options });
    if (!evt?.bodyAvailable) return false;
    node.dataset.eventSeq = String(evt.seq || '');
    node.dataset.bodyPending = 'true';
    node.dataset.bodyRender = options.renderMode || 'text';
    node.dataset.preview = options.preview || '';
    return true;
  },
  queueHydrateLazyNodes(node) {
    hydrateCalls.push(node);
  },
};
context.globalThis = context;

vm.runInNewContext(
  [
    renderReasoningIntoSource,
    'globalThis.renderReasoningInto = renderReasoningInto;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/ui.js' },
);

const contentContainer = makeElement('div');
const contentNode = context.renderReasoningInto(contentContainer, {
  content: '**Inspecting**\n\n- item one\n- item two',
});

assert.equal(contentContainer.children.length, 1, 'reasoning content should append one rendered block');
assert.equal(contentNode.className, 'reasoning md-content', 'reasoning content should opt into markdown styling');
assert.equal(markdownCalls.length, 1, 'reasoning content should render through the markdown renderer');
assert.equal(markdownCalls[0].markdown, '**Inspecting**\n\n- item one\n- item two', 'reasoning markdown should be passed through intact');

const hydratedContainer = makeElement('div');
const hydratedNode = context.renderReasoningInto(hydratedContainer, {
  seq: 12,
  bodyAvailable: true,
  bodyLoaded: false,
  bodyPreview: 'Preview **markdown**',
});

assert.equal(markdownCalls.length, 2, 'reasoning preview bodies should also render through markdown');
assert.equal(lazyCalls.length, 2, 'reasoning rendering should set up lazy hydration for deferred bodies');
assert.equal(lazyCalls[1].options.renderMode, 'markdown', 'deferred reasoning bodies should hydrate as markdown, not plain text');
assert.equal(hydratedNode.dataset.bodyRender, 'markdown', 'lazy reasoning nodes should persist markdown render mode on the DOM node');
assert.equal(hydrateCalls.length, 1, 'deferred reasoning bodies should queue hydration after initial preview render');

console.log('test-chat-thought-block-reasoning-markdown: ok');
