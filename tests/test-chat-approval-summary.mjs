#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');
const cssSource = readFileSync(join(repoRoot, 'static', 'chat', 'chat-messages.css'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const functionStart = source.indexOf(marker);
  assert.notEqual(functionStart, -1, `${functionName} should exist`);
  const asyncPrefixStart = source.lastIndexOf('async ', functionStart);
  const start = asyncPrefixStart >= 0 && asyncPrefixStart + 'async '.length === functionStart
    ? asyncPrefixStart
    : functionStart;
  const paramsStart = source.indexOf('(', start);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    if (source[index] === '(') paramsDepth += 1;
    if (source[index] === ')') {
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
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

function makeElement(tagName = 'div') {
  return {
    tagName: String(tagName).toUpperCase(),
    className: '',
    textContent: '',
    dataset: {},
    attrs: {},
    children: [],
    parentNode: null,
    disabled: false,
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    replaceChild(nextChild, previousChild) {
      const index = this.children.indexOf(previousChild);
      assert.notEqual(index, -1, 'previous child should be attached');
      nextChild.parentNode = this;
      previousChild.parentNode = null;
      this.children[index] = nextChild;
      return previousChild;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const matches = [];
      const classMatch = selector.match(/\.([A-Za-z0-9_-]+)/);
      const wantsApprovalId = selector.includes('[data-approval-id]');
      const visit = (node) => {
        const classes = String(node.className || '').split(/\s+/).filter(Boolean);
        const hasClass = !classMatch || classes.includes(classMatch[1]);
        const hasApprovalId = !wantsApprovalId || Boolean(node.dataset?.approvalId);
        if (hasClass && hasApprovalId) matches.push(node);
        for (const child of node.children || []) visit(child);
      };
      visit(this);
      return matches;
    },
    addEventListener(type, handler) {
      this[`on${type}`] = handler;
    },
    closest(selector) {
      let node = this;
      const classMatch = selector.match(/\.([A-Za-z0-9_-]+)/);
      while (node) {
        const classes = String(node.className || '').split(/\s+/).filter(Boolean);
        if (!classMatch || classes.includes(classMatch[1])) return node;
        node = node.parentNode;
      }
      return null;
    },
  };
}

// (2026-08-04) The in-stream approval card renderers are removed — the
// Decision Sheet owns the request surface; only the summary + shared helpers
// stay.
const functionNames = [
  'getApprovalEventId',
  'isSessionConfirmationApproval',
  'getApprovalKindLabel',
  'getApprovalTitle',
  'normalizeApprovalStatus',
  'getApprovalStatusLabel',
  'createApprovalDetail',
  'describeApprovalPermissions',
  'createRuntimeApprovalSummary',
  'submitRuntimeApprovalDecision',
  'readApprovalPromptText',
  'normalizeApprovalPromptOption',
  'collectApprovalPromptOptions',
  'getApprovalPromptSections',
  'createApprovalPromptSection',
  'renderApprovalResponseInto',
];

const messages = {
  'approval.kind.command': 'Command',
  'approval.kind.fileChange': 'File change',
  'approval.kind.permissions': 'Permissions',
  'approval.kind.confirmation': 'Confirmation',
  'approval.kind.generic': 'Runtime',
  'approval.card.label': 'Approval',
  'approval.card.title': '{kind} approval required',
  'approval.status.pending': 'Needs review',
  'approval.status.submitting': 'Submitting…',
  'approval.status.approved': 'Approved',
  'approval.status.denied': 'Denied',
  'approval.status.cancelled': 'Cancelled',
  'approval.status.resolved': 'Ended',
  'attention.approval.title': 'Approval needed',
  'approval.summary.approved': 'Approved: {title}',
  'approval.summary.denied': 'Denied: {title}',
  'approval.action.approve': 'Approve',
  'approval.action.approveForSession': 'Approve session',
  'approval.action.deny': 'Deny',
};

const context = {
  document: { createElement: makeElement },
  console,
  currentSessionId: 'session-test',
  dispatchAction: async () => true,
  t(key, values = {}) {
    return String(messages[key] || key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
  },
};
vm.createContext(context);
vm.runInContext(functionNames.map((name) => extractFunctionSource(uiSource, name)).join('\n'), context);

// Since 2026-08-04 approval requests no longer render into the message stream —
// the Decision Sheet owns the request surface (fed via decisions-store). Only
// the auditable summary line renders here, from the approval_response event.
const container = makeElement('div');
const request = {
  type: 'approval_request',
  approvalId: 'approval-summary-1',
  kind: 'command',
  command: 'echo hello',
  status: 'pending',
};

const summary = context.renderApprovalResponseInto(container, {
  type: 'approval_response',
  approvalId: 'approval-summary-1',
  kind: 'command',
  status: 'approved',
});
assert.equal(container.children.length, 1);
assert.equal(container.children[0], summary);
assert.equal(summary.className, 'runtime-approval-summary');
assert.equal(summary.dataset.status, 'approved');
assert.equal(summary.textContent, 'Approved: Approval needed');

const denied = context.renderApprovalResponseInto(container, {
  type: 'approval_response',
  approvalId: 'approval-summary-2',
  kind: 'command',
  status: 'denied',
});
assert.equal(denied.className, 'runtime-approval-summary', 'denied responses render the auditable summary');
assert.equal(denied.textContent, 'Denied: Approval needed');

// Ask-user prompt sections still render through createApprovalPromptSection —
// reused by the Decision Sheet's question kind.
const section = {
  id: 'release_path',
  header: 'Release',
  question: 'Which rollout path should I use?',
  options: [
    { label: 'Canary first', value: 'Canary first', description: 'Ship to one workspace before broad rollout.' },
    { label: 'Full rollout', value: 'Full rollout', description: 'Ship the change everywhere after tests pass.' },
  ],
};
const askUserPrompt = context.createApprovalPromptSection(section, 0);
assert.ok(askUserPrompt, 'ask-user confirmations should render prompt content');
assert.equal(askUserPrompt.dataset.questionId, 'release_path');
assert.equal(askUserPrompt.querySelector('.runtime-approval-card__prompt-header').textContent, 'Release');
assert.equal(askUserPrompt.querySelector('.runtime-approval-card__question').textContent, 'Which rollout path should I use?');
const askUserOptions = askUserPrompt.querySelectorAll('.runtime-approval-card__option');
assert.equal(askUserOptions.length, 2, 'ask-user confirmations should render all options');
assert.equal(askUserOptions[0].dataset.optionValue, 'Canary first');
assert.equal(askUserOptions[0].querySelector('.runtime-approval-card__option-label').textContent, 'Canary first');
assert.equal(
  askUserOptions[0].querySelector('.runtime-approval-card__option-description').textContent,
  'Ship to one workspace before broad rollout.',
);

// submitRuntimeApprovalDecision dispatches the decision; the summary renders
// from the approval_response event (no card DOM to swap anymore).
let dispatched = null;
const submitContext = {
  ...context,
  dispatchAction: async (payload) => { dispatched = payload; return true; },
};
vm.createContext(submitContext);
vm.runInContext(functionNames.map((name) => extractFunctionSource(uiSource, name)).join('\n'), submitContext);
const submitOk = await submitContext.submitRuntimeApprovalDecision(
  { ...request, approvalId: 'approval-summary-3', runId: 'run-summary-3' },
  'deny',
  null,
);
assert.equal(submitOk, true, 'submitRuntimeApprovalDecision resolves true on ok');
assert.equal(dispatched.action, 'runtime_approval');
assert.equal(dispatched.decision, 'deny');
assert.equal(dispatched.approvalId, 'approval-summary-3');
assert.equal(dispatched.runId, 'run-summary-3');

assert.match(cssSource, /\.runtime-approval-summary\s*\{[^}]*color:\s*var\(--text-muted\)/s);
assert.match(cssSource, /\.runtime-approval-summary\s*\{[^}]*font-size:\s*11px/s);

// Gone-approval handling (2026-08-05): cancelled (run-finalize) and resolved
// (frontend gone-approval path) statuses get honest labels, kept distinct from
// denied — the approval was not refused, it simply ended.
assert.equal(context.normalizeApprovalStatus('cancelled'), 'cancelled');
assert.equal(context.normalizeApprovalStatus('canceled'), 'cancelled');
assert.equal(context.normalizeApprovalStatus('ended'), 'resolved');
assert.equal(context.normalizeApprovalStatus('expired'), 'resolved');
assert.equal(context.getApprovalStatusLabel({ status: 'cancelled' }), 'Cancelled');
assert.equal(context.getApprovalStatusLabel({ status: 'resolved' }), 'Ended');

console.log('chat approval summary tests passed');
