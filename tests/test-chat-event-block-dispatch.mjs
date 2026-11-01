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

const renderHiddenBlockEventsIntoSource = extractFunctionSource(uiSource, 'renderHiddenBlockEventsInto');
const renderUsageIntoSource = extractFunctionSource(uiSource, 'renderUsageInto');
const updateContextDisplaySource = extractFunctionSource(uiSource, 'updateContextDisplay');

const calls = [];
const context = {
  console,
  renderMessageInto(container, event) {
    calls.push(`message:${event.role || 'assistant'}`);
    return { container, event };
  },
  renderReasoningInto(container, event) {
    calls.push(`reasoning:${event.content}`);
    return { container, event };
  },
  renderManagerContextInto(container, event) {
    calls.push(`manager_context:${event.content}`);
    return { container, event };
  },
  renderApprovalRequestInto(container, event) {
    calls.push(`approval_request:${event.approvalId}`);
    return { container, event };
  },
  renderApprovalResponseInto(container, event) {
    calls.push(`approval_response:${event.approvalId}:${event.status}`);
    return { container, event };
  },
  renderToolUseInto(container, event) {
    calls.push(`tool_use:${event.toolName}`);
    return { container, event };
  },
  renderToolResultInto(container, event) {
    calls.push(`tool_result:${event.toolName}`);
    return { container, event };
  },
  renderFileChangeInto(container, event) {
    calls.push(`file_change:${event.filePath}`);
    return { container, event };
  },
  renderFileChangeEditingStatusInto(container, event) {
    calls.push(`file_change_editing:${event.filePath}`);
    return { container, event };
  },
  renderStatusInto(container, event) {
    calls.push(`status:${event.content}`);
    return { container, event };
  },
  renderContextBarrierInto(container, event) {
    calls.push(`context_barrier:${event.content}`);
    return { container, event };
  },
  renderContextOperationInto(container, event) {
    calls.push(`context_operation:${event.title || event.content}`);
    return { container, event };
  },
  renderUsageInto(container, event) {
    calls.push(`usage:${event.outputTokens || 0}`);
    return { container, event };
  },
  renderUnknownEventInto(container, event) {
    calls.push(`unknown:${event.type}`);
    return { container, event };
  },
};
context.globalThis = context;

vm.runInNewContext(
  [
    renderHiddenBlockEventsIntoSource,
    'globalThis.renderHiddenBlockEventsInto = renderHiddenBlockEventsInto;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/ui.js' },
);

context.renderHiddenBlockEventsInto({}, [
  { type: 'message', role: 'assistant', content: 'draft' },
  { type: 'status', content: 'Preparing environment' },
  { type: 'reasoning', content: 'Inspecting files' },
  { type: 'manager_context', content: 'Manager note: keep replies in prose.' },
  { type: 'approval_request', approvalId: 'approval-hidden-1' },
  { type: 'approval_response', approvalId: 'approval-hidden-1', status: 'approved' },
  { type: 'tool_use', toolName: 'bash' },
  { type: 'tool_result', toolName: 'bash' },
  { type: 'file_change', filePath: 'src/app.js' },
  { type: 'usage', outputTokens: 42 },
  { type: 'context_barrier', content: 'Older messages above this marker are no longer in the current context.' },
  { type: 'context_operation', title: 'Current context compacted' },
  { type: 'template_context', content: 'internal note' },
]);

assert.deepEqual(calls, [
  'message:assistant',
  'status:Preparing environment',
  'reasoning:Inspecting files',
  'manager_context:Manager note: keep replies in prose.',
  // approval_request is a no-op in the stream since 2026-08-04 (Decision Sheet).
  'approval_response:approval-hidden-1:approved',
  'tool_use:bash',
  'tool_result:bash',
  'file_change_editing:src/app.js',
  'file_change:src/app.js',
  'usage:42',
  'context_barrier:Older messages above this marker are no longer in the current context.',
  'context_operation:Current context compacted',
  'unknown:template_context',
], 'expanded folded blocks should render all folded event kinds and fall back safely for unknown ones');

let usageContextUpdate = null;
const usageContext = {
  getContextTokens: () => 166000,
  getContextWindowTokens: () => 200000,
  updateContextDisplay(contextSize, contextWindowSize) {
    usageContextUpdate = { contextSize, contextWindowSize };
  },
};
usageContext.globalThis = usageContext;
vm.runInNewContext(
  [renderUsageIntoSource, 'globalThis.renderUsageInto = renderUsageInto;'].join('\n\n'),
  usageContext,
  { filename: 'static/chat/ui.js' },
);
let usageAppendCount = 0;
const usageRenderResult = usageContext.renderUsageInto(
  { appendChild() { usageAppendCount += 1; } },
  { contextTokens: 166000, contextWindowTokens: 200000, outputTokens: 5000 },
  { updateContext: true },
);
assert.equal(usageRenderResult, null, 'usage events should not create visible transcript elements');
assert.equal(usageAppendCount, 0, 'usage events should not append context/output summary text');
assert.deepEqual(
  usageContextUpdate,
  { contextSize: 166000, contextWindowSize: 200000 },
  'hidden usage events should continue updating internal context state',
);

const contextTokens = { textContent: '166K 当前上下文', title: 'token details', style: { display: '' } };
const compactBtn = { style: { display: 'none' } };
const dropToolsBtn = { style: { display: 'none' } };
const contextDisplayContext = {
  currentTokens: 0,
  currentSessionId: 'session-1',
  contextTokens,
  compactBtn,
  dropToolsBtn,
  syncComposerModeUi() {},
};
contextDisplayContext.globalThis = contextDisplayContext;
vm.runInNewContext(
  [updateContextDisplaySource, 'globalThis.updateContextDisplay = updateContextDisplay;'].join('\n\n'),
  contextDisplayContext,
  { filename: 'static/chat/ui.js' },
);
contextDisplayContext.updateContextDisplay(166000, 200000);
assert.equal(contextDisplayContext.currentTokens, 166000, 'context size should remain available internally');
assert.equal(contextTokens.textContent, '', 'composer should not display the context token summary');
assert.equal(contextTokens.title, '', 'composer should not expose token summary hover text');
assert.equal(contextTokens.style.display, 'none', 'composer token summary should remain hidden');
assert.equal(compactBtn.style.display, '', 'context controls should remain available');
assert.equal(dropToolsBtn.style.display, '', 'drop-tools control should remain available');

console.log('test-chat-event-block-dispatch: ok');
