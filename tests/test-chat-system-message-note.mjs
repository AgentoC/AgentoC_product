#!/usr/bin/env node
// Per-message system prompt rendering: a system-role message event (injected
// server-side via the agent's perMessageSystemPrompt config) must render as a
// compact .msg-system-note instead of a chat bubble. Serves the real
// renderMessageInto source from static/chat/ui.js in a VM with stubbed DOM.
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
    parentNode: null,
    children: [],
    get lastElementChild() {
      return this.children[this.children.length - 1] || null;
    },
    appendChild(child) {
      if (child?.parentNode && child.parentNode !== this) {
        child.parentNode.children = child.parentNode.children.filter((node) => node !== child);
      }
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    classList: {
      add(...names) {
        for (const name of names) this.className = [this.className, name].filter(Boolean).join(' ');
      },
    },
  };
}

const renderMessageHelpersSource = [
  'getAssistantRunMergeKeyForRender',
  'hasElementClass',
  'getDirectChildByClass',
  'isAssistantRunMergeBoundaryNode',
  'findAssistantRunMergeNode',
  'insertAssistantBubbleChildBeforeMeta',
  'renderAssistantMergedContent',
  'renderAssistantMergedContentSegment',
  'getAssistantMessageRenderAttachments',
  'getAttachmentRenderIdentity',
  'appendAssistantAttachmentsToBubble',
  'mergeAssistantMessageIntoExistingBubble',
  'setMessageForkBoundary',
  'renderMessageInto',
].map((functionName) => extractFunctionSource(uiSource, functionName)).join('\n\n');
const markdownCalls = [];
const timestampCalls = [];

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
  appendMessageTimestamp(node, stamp, extraClass = '') {
    timestampCalls.push({ node, stamp, extraClass });
  },
  markLazyEventBodyNode() {
    return false;
  },
  queueHydrateLazyNodes() {},
  isAssistantMessageLive() {
    return false;
  },
  formatDecodedDisplayText(value) {
    return typeof value === 'string' ? value : '';
  },
  createMessageAttachmentNode(attachment) {
    return makeElement('video');
  },
  inThinkingBlock: false,
  finalizeThinkingBlock() {},
  syncEditableMessageActions() {},
  createUserMessageNode(evt) {
    const el = makeElement('div');
    el.className = 'msg-user';
    el.textContent = typeof evt?.content === 'string' ? evt.content : '';
    return el;
  },
};
context.globalThis = context;

vm.runInNewContext(
  [
    renderMessageHelpersSource,
    'globalThis.renderMessageInto = renderMessageInto;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/ui.js' },
);

const container = makeElement('div');

// System-role message event (per-message system prompt) renders as a note.
const systemEvent = {
  role: 'system',
  systemPromptKey: 'agent.perMessageSystemPrompt',
  content: '要充分结合前端开发规范，用好 skills',
  timestamp: '2026-08-05T00:00:00.000Z',
};
const note = context.renderMessageInto(container, systemEvent);
assert.equal(note, container.children[0], 'system event should render a node');
assert.equal(note.className, 'msg-system-note', 'system note uses the .msg-system-note class');
assert.equal(note.textContent, '要充分结合前端开发规范，用好 skills', 'system note preserves the prompt text');
assert.equal(container.children.length, 1, 'exactly one node rendered');
assert.equal(markdownCalls.length, 0, 'system notes are plain text, not markdown');

// Empty system events render nothing.
const beforeEmptyCount = container.children.length;
const emptyNote = context.renderMessageInto(container, { role: 'system', content: '   ' });
assert.equal(emptyNote, null, 'blank system note renders nothing');
assert.equal(container.children.length, beforeEmptyCount, 'blank system note adds no node');

// User and assistant branches still render as before.
const userNode = context.renderMessageInto(container, { role: 'user', content: 'hello' });
assert.equal(userNode, container.children[container.children.length - 1], 'user message still renders');
const assistantNode = context.renderMessageInto(container, {
  role: 'assistant',
  content: 'reply',
  attachments: [],
  timestamp: '2026-08-05T00:00:00.000Z',
});
assert.ok(assistantNode, 'assistant message still renders');
assert.equal(assistantNode.className, 'msg-assistant md-content', 'assistant bubble keeps its class');

console.log('PASS test-chat-system-message-note');
