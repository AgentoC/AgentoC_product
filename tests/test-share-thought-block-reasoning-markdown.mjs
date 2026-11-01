#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const chatUiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist in static/chat/ui.js`);
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
    innerHTML: '',
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };
}

const renderReasoningIntoSource = extractFunctionSource(chatUiSource, 'renderReasoningInto');
const container = makeElement('div');
const markdownCalls = [];
const lazyCalls = [];
const context = {
  console,
  document: {
    createElement(tagName) {
      return makeElement(tagName);
    },
  },
  renderMarkdownIntoNode(node, markdown) {
    markdownCalls.push(markdown);
    node.innerHTML = `<p>${markdown}</p>`;
    node.renderedMarkdown = markdown;
    return true;
  },
  markLazyEventBodyNode(node, evt, options) {
    lazyCalls.push({ node, evt, options });
    return false;
  },
  queueHydrateLazyNodes() {},
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

const rendered = context.renderReasoningInto(container, {
  content: '**Inspecting**\n\n- item one',
});

assert.equal(markdownCalls.length, 1, 'share thought reasoning should render through markdown');
assert.equal(container.children.length, 1, 'share thought reasoning should append one node');
assert.equal(rendered, container.children[0], 'share thought reasoning should return the rendered node');
assert.equal(container.children[0].className, 'reasoning md-content', 'share thought reasoning should reuse the main chat markdown styles');
assert.equal(container.children[0].renderedMarkdown, '**Inspecting**\n\n- item one', 'share thought reasoning should pass markdown through the chat renderer');
assert.equal(lazyCalls.length, 1, 'share thought reasoning should preserve lazy-body wiring');

console.log('test-share-thought-block-reasoning-markdown: ok');
