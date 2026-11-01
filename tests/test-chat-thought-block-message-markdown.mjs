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
    parentNode: null,
    children: [],
    get lastElementChild() {
      return this.children[this.children.length - 1] || null;
    },
    appendChild(child) {
      if (child?.parentNode && child.parentNode !== this) {
        child.parentNode.children = child.parentNode.children.filter((node) => node !== child);
      }
      if (child?.parentNode === this) {
        this.children = this.children.filter((node) => node !== child);
      }
      this.children.push(child);
      if (child) child.parentNode = this;
      return child;
    },
    insertBefore(child, anchor) {
      if (!anchor || !this.children.includes(anchor)) {
        return this.appendChild(child);
      }
      if (child?.parentNode && child.parentNode !== this) {
        child.parentNode.children = child.parentNode.children.filter((node) => node !== child);
      }
      if (child?.parentNode === this) {
        this.children = this.children.filter((node) => node !== child);
      }
      const anchorIndex = this.children.indexOf(anchor);
      this.children.splice(anchorIndex, 0, child);
      if (child) child.parentNode = this;
      return child;
    },
    querySelectorAll(selector) {
      const results = [];
      const className = selector.startsWith('.') ? selector.slice(1) : '';
      const walk = (node) => {
        for (const child of node.children || []) {
          if (className && ` ${child.className} `.includes(` ${className} `)) results.push(child);
          walk(child);
        }
      };
      walk(this);
      return results;
    },
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter((node) => node !== this);
      this.parentNode = null;
    },
  };
}

const renderMessageHelpersSource = [
  'setMessageForkBoundary',
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
  'shouldCollapseUserMessageContent',
  'appendUserMessageDisclosure',
  'createUserMessageNode',
  'renderMessageInto',
].map((functionName) => extractFunctionSource(uiSource, functionName)).join('\n\n');
const markdownCalls = [];
const timestampCalls = [];
const attachmentCalls = [];

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
    attachmentCalls.push(attachment);
    return makeElement('video');
  },
  inThinkingBlock: false,
  currentSessionId: '',
  finalizeThinkingBlock() {
    context.finalizedThinkingBlock = true;
  },
};
context.globalThis = context;

vm.runInNewContext(
  [
    renderMessageHelpersSource,
    'globalThis.createUserMessageNode = createUserMessageNode;\n    globalThis.renderMessageInto = renderMessageInto;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/ui.js' },
);

const container = makeElement('div');
const assistantMessage = {
  role: 'assistant',
  content: 'Before final answer:\n\n- item **one**\n- item `two`',
  attachments: [{
    assetId: 'fasset_1234567890abcdef12345678',
    originalName: 'rough cut.mp4',
    mimeType: 'video/mp4',
  }],
  timestamp: '2026-03-17T10:00:00.000Z',
};

const node = context.renderMessageInto(container, assistantMessage);

assert.equal(container.children.length, 1, 'assistant message should append exactly one rendered node');
assert.equal(container.children[0], node, 'renderMessageInto should return the appended assistant node');
assert.equal(node.className, 'msg-assistant md-content', 'assistant messages should keep markdown-capable styling');
assert.equal(node.children.length, 2, 'assistant node should render both markdown and attachments when present');
assert.equal(node.children[0].className, 'msg-assistant-body', 'assistant node should render into the assistant body wrapper');
assert.equal(node.children[1].className, 'msg-images', 'assistant attachments should render in the attachment strip');
assert.equal(node.children[1].children.length, 1, 'assistant attachment strip should include the generated download attachment');
assert.equal(markdownCalls.length, 1, 'assistant message rendering should invoke the markdown renderer');
assert.equal(markdownCalls[0].markdown, assistantMessage.content, 'assistant message rendering should pass the original message text into markdown');
assert.equal(attachmentCalls.length, 1, 'assistant message rendering should build attachment nodes for assistant images');
assert.equal(timestampCalls.length, 1, 'assistant message rendering should still append timestamps');

const userMarkdown = '用户 **重点**，~~旧内容~~ 已更新。';
const userNode = context.createUserMessageNode({
  role: 'user',
  content: userMarkdown,
});
assert.equal(userNode.className, 'msg-user', 'user messages should keep the user message wrapper');
assert.equal(userNode.children[0].className, 'msg-user-bubble', 'user Markdown should render inside the user bubble');
assert.equal(userNode.children[0].children[0].className, 'md-content', 'user bubbles should use the shared Markdown content class');
assert.equal(markdownCalls.at(-1).markdown, userMarkdown, 'user message rendering should pass the original Markdown source to the shared renderer');

const userWithAttachment = context.createUserMessageNode({
  role: 'user',
  content: '带附件的用户消息',
  attachments: [{ assetId: 'asset-1', originalName: 'notes.txt', mimeType: 'text/plain' }],
});
assert.equal(userWithAttachment.children[0].className, 'msg-images', 'sent attachments should be siblings above the user bubble');
assert.equal(userWithAttachment.children[1].className, 'msg-user-bubble', 'sent message text should remain inside the user bubble');
assert.equal(userWithAttachment.children[0].children.length, 1, 'the external attachment strip should retain every attachment');
assert.equal(
  Array.from(userWithAttachment.children[1].children).some((child) => child.className === 'msg-images'),
  false,
  'sent attachments should not be nested in the bubble',
);

const mergeContainer = makeElement('div');
const firstRunBubble = context.renderMessageInto(mergeContainer, {
  type: 'message',
  role: 'assistant',
  runId: 'run_ui_merge',
  content: '第一段可见输出。',
});
const secondRunBubble = context.renderMessageInto(mergeContainer, {
  type: 'message',
  role: 'assistant',
  runId: 'run_ui_merge',
  content: '第二段可见输出。',
});

assert.equal(
  secondRunBubble,
  firstRunBubble,
  'same-run realtime assistant output should reuse the existing assistant bubble',
);
assert.equal(
  mergeContainer.children.length,
  1,
  'same-run realtime assistant output should not append a second assistant bubble',
);
assert.equal(
  mergeContainer.children[0],
  firstRunBubble,
  'same-run realtime assistant output should keep one merged bubble when no boundary intervenes',
);
assert.equal(
  firstRunBubble.dataset.assistantRunMergedContent,
  '第一段可见输出。\n\n第二段可见输出。',
  'same-run realtime assistant output should keep both visible parts in one markdown payload',
);
assert.equal(
  markdownCalls[markdownCalls.length - 1].markdown,
  '第二段可见输出。',
  'same-run realtime assistant output should render only the new part incrementally',
);
assert.equal(
  firstRunBubble.querySelectorAll('.msg-assistant-body').length,
  2,
  'incremental merges should append one body segment per part instead of re-rendering the whole bubble',
);

context.renderMessageInto(mergeContainer, {
  type: 'message',
  role: 'assistant',
  runId: 'run_ui_merge',
  content: '第一段可见输出。\n\n第二段可见输出。\n\n最终输出。',
  mergedAssistantRunMessage: true,
});

assert.equal(
  firstRunBubble.dataset.assistantRunMergedContent,
  '第一段可见输出。\n\n第二段可见输出。\n\n最终输出。',
  'server-merged same-run assistant events should replace the bubble content instead of appending a duplicate prefix',
);

const historicalPrependContainer = makeElement('div');
const newerRunBubble = context.renderMessageInto(historicalPrependContainer, {
  type: 'message',
  role: 'assistant',
  runId: 'run_ui_history_prepend',
  content: '较新的可见输出。',
});
const olderRunBubble = context.renderMessageInto(historicalPrependContainer, {
  type: 'message',
  role: 'assistant',
  runId: 'run_ui_history_prepend',
  content: '更早的历史输出。',
}, {
  mergeAssistantRunMessages: false,
});

assert.notEqual(
  olderRunBubble,
  newerRunBubble,
  'history prepend assistant messages should not merge into a newer same-run bubble',
);
assert.equal(
  historicalPrependContainer.children.length,
  2,
  'history prepend assistant messages should render as movable standalone nodes',
);
assert.equal(
  historicalPrependContainer.children[0],
  newerRunBubble,
  'disabling merge should not move the newer same-run bubble to the bottom',
);
assert.equal(
  historicalPrependContainer.children[1],
  olderRunBubble,
  'the historical assistant node should append independently so the prepend loader can move it above the anchor',
);

const thinkingBoundaryContainer = makeElement('div');
const beforeThinkingBubble = context.renderMessageInto(thinkingBoundaryContainer, {
  type: 'message',
  role: 'assistant',
  runId: 'run_ui_thinking_boundary',
  content: 'thinking 之前的输出。',
});
const thinkingBlock = makeElement('div');
thinkingBlock.className = 'thinking-block';
thinkingBoundaryContainer.appendChild(thinkingBlock);
const afterThinkingBubble = context.renderMessageInto(thinkingBoundaryContainer, {
  type: 'message',
  role: 'assistant',
  runId: 'run_ui_thinking_boundary',
  content: 'thinking 之后的输出。',
});

assert.notEqual(
  afterThinkingBubble,
  beforeThinkingBubble,
  'same-run realtime assistant output should not merge across an intervening thinking block',
);
assert.equal(
  thinkingBoundaryContainer.children.length,
  3,
  'same-run realtime assistant output should keep separate bubbles around the thinking boundary',
);
assert.equal(
  thinkingBoundaryContainer.children[1],
  thinkingBlock,
  'thinking block should remain between the pre- and post-thinking assistant bubbles',
);
assert.equal(
  beforeThinkingBubble.dataset.assistantRunMergedContent,
  'thinking 之前的输出。',
  'pre-thinking assistant bubble should retain only pre-thinking content',
);
assert.equal(
  afterThinkingBubble.dataset.assistantRunMergedContent,
  'thinking 之后的输出。',
  'post-thinking assistant bubble should start a new merge group',
);

const steeredRunContainer = makeElement('div');
const beforeSteerBubble = context.renderMessageInto(steeredRunContainer, {
  type: 'message',
  role: 'assistant',
  runId: 'run_ui_steered',
  content: 'steer 之前的输出。',
});
const steerUserMessage = makeElement('div');
steerUserMessage.className = 'msg-user';
steeredRunContainer.appendChild(steerUserMessage);
const afterSteerBubble = context.renderMessageInto(steeredRunContainer, {
  type: 'message',
  role: 'assistant',
  runId: 'run_ui_steered',
  content: 'steer 之后的输出。',
});

assert.notEqual(
  afterSteerBubble,
  beforeSteerBubble,
  'same-run realtime assistant output should not merge across an intervening user steer',
);
assert.equal(
  steeredRunContainer.children.length,
  3,
  'same-run realtime assistant output should keep separate bubbles around the steer boundary',
);
assert.equal(
  beforeSteerBubble.dataset.assistantRunMergedContent,
  'steer 之前的输出。',
  'pre-steer assistant bubble should retain only pre-steer content',
);
assert.equal(
  afterSteerBubble.dataset.assistantRunMergedContent,
  'steer 之后的输出。',
  'post-steer assistant bubble should start a new merge group',
);

console.log('test-chat-thought-block-message-markdown: ok');
