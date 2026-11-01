#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const messageCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-messages.css'), 'utf8');
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');
const realtimeRenderSource = readFileSync(join(repoRoot, 'static', 'chat', 'realtime-render.js'), 'utf8');

// 1. The launch flight is played imperatively on the echo element (WAAPI), not
// driven by a CSS class: a class-driven keyframe gets cancelled mid-air when
// the committed node replaces the echo during the sending -> sent hand-off,
// and its cleanup re-triggers the base entry animation. Guard against both.
assert.doesNotMatch(
  messageCss,
  /\.msg-user\.is-launching|user-msg-launch-to-top|--user-msg-launch-y/,
  'chat-messages.css must not drive the send launch via a CSS class or custom property',
);

assert.match(
  uiSource,
  /launchDeltaY > 8[\s\S]*?wrap\.animate\(\s*\[[\s\S]*?translateY\(\$\{Math\.round\(launchDeltaY\)\}px\)[\s\S]*?duration:\s*380[\s\S]*?cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\)/,
  'launchUserMessageToTop should play a 380ms WAAPI flight from the measured composer distance',
);

assert.match(
  uiSource,
  /adoptCommittedUserMessageIntoEcho\(localEcho, wrap\)/,
  'committed render must upgrade the echo element in place so the flight survives the ACK',
);

assert.match(
  uiSource,
  /flight\.finished[\s\S]*?dockTurnToTop\(wrap\)/,
  'the completed flight must re-dock against the latest layout instead of relying on its initial measurement',
);

assert.doesNotMatch(
  messageCss,
  /\.turn-viewport-spacer\s*\{[^}]*transition:/,
  'turn-viewport-spacer height must not transition: it is paired with an instant scrollTop write in the same task',
);

// 2. Functional DOM test in vm context
globalThis.__launchFlights = [];

function createMockElement(tagName = 'div') {
  const dataset = {};
  const style = {
    _props: {},
    setProperty(k, v) { this._props[k] = String(v); },
    removeProperty(k) { delete this._props[k]; },
    getPropertyValue(k) { return this._props[k] || ''; },
  };
  const classes = new Set();
  const children = [];
  const element = {
    tagName: tagName.toUpperCase(),
    dataset,
    style,
    children,
    parentNode: null,
    clientHeight: 800,
    scrollHeight: 800,
    scrollTop: 0,
    offsetHeight: 60,
    offsetTop: 0,
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); },
      toggle(c, on) { on ? classes.add(c) : classes.delete(c); },
    },
    get className() { return Array.from(classes).join(' '); },
    set className(val) {
      classes.clear();
      (val || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
    get lastElementChild() { return children[children.length - 1] || null; },
    get previousElementSibling() {
      if (!this.parentNode) return null;
      const idx = this.parentNode.children.indexOf(this);
      return idx > 0 ? this.parentNode.children[idx - 1] : null;
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      children.push(child);
      return child;
    },
    insertBefore(child, before) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      const idx = children.indexOf(before);
      if (idx >= 0) children.splice(idx, 0, child);
      else children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx >= 0) children.splice(idx, 1);
      child.parentNode = null;
      return child;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    setAttribute(k, v) { dataset[k] = v; },
    removeAttribute(k) { delete dataset[k]; },
    getAttribute(k) { return dataset[k] || null; },
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return { top: 70, bottom: 130, height: 60, width: 300, left: 100, right: 400 };
    },
    animate(keyframes, options) {
      globalThis.__launchFlights.push({ keyframes, options, element: element });
      return { cancel() {}, finished: Promise.resolve() };
    },
    querySelector(selector) {
      return children.find((c) => c.className?.includes(selector.replace('.', ''))) || null;
    },
    querySelectorAll(selector) {
      return children.filter((c) => c.className?.includes(selector.replace('.', '')));
    },
  };
  return element;
}

const context = {
  currentSessionId: 'session-launch-test',
  messagesEl: createMockElement('div'),
  messagesInner: createMockElement('div'),
  emptyState: createMockElement('div'),
  document: {
    getElementById(id) {
      if (id === 'turnViewportSpacer') return context.messagesInner.children.find((c) => c.id === 'turnViewportSpacer') || null;
      if (id === 'msgAssistantPending') return context.messagesInner.children.find((c) => c.id === 'msgAssistantPending') || null;
      if (id === 'inputArea') {
        const el = createMockElement('div');
        el.getBoundingClientRect = () => ({ top: 740, bottom: 820, height: 80, width: 600, left: 100, right: 700 });
        return el;
      }
      return null;
    },
    createElement(tag) {
      const el = createMockElement(tag);
      return el;
    },
  },
  window: {
    matchMedia: () => ({ matches: false }),
  },
  scrollToBottom() {},
  getComposerPendingSendSnapshot() { return null; },
  getComposerRetainedSendState() { return null; },
  clearComposerRetainedSendState() {},
  removeComposerPendingUserStatuses() {},
  getProtectedComposerEchoRequestIds() { return []; },
  findLocalEchoUserMessageNode() { return null; },
  findCommittedUserMessageNode() { return null; },
  syncEditableMessageActions() {},
  renderRealtimeIcon: () => '<svg></svg>',
  formatDecodedDisplayText: (t) => t,
  marked: { parse: (t) => `<p>${t}</p>` },
  enhanceCodeBlocks() {},
  performance: { now: () => Date.now() },
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  setTimeout,
};
context.window.document = context.document;
context.window.window = context.window;

vm.createContext(context);
vm.runInContext(`${realtimeRenderSource}\n${uiSource}\nthis.__api = { getActiveTurnSpacerHeight, getOrCreateTurnViewportSpacer, removeTurnViewportSpacer, syncTurnViewportSpacerOnGrowth, launchUserMessageToTop, insertComposerLocalEcho, syncComposerPendingTurnFeedback };`, context);

// Test spacer height computation
const userBubble = createMockElement('div');
userBubble.offsetHeight = 56;
userBubble.offsetTop = 100;
const pendingNode = createMockElement('div');
pendingNode.offsetHeight = 40;
context.messagesEl.clientHeight = 800;

const spacerHeight = context.__api.getActiveTurnSpacerHeight(userBubble, pendingNode);
assert.equal(spacerHeight, 800 - 56 - 40 - 24, 'active turn spacer height should guarantee space for bubble to dock at top');

// Test insertComposerLocalEcho inserts user bubble, pending assistant, and spacer
const inserted = context.__api.insertComposerLocalEcho({
  requestId: 'req-launch-1',
  text: 'Launch this to the top of the viewport',
  sessionId: 'session-launch-test',
  scroll: true,
});
assert.equal(inserted, true, 'insertComposerLocalEcho should succeed');

const userMsg = context.messagesInner.children.find((c) => c.className?.includes('msg-user'));
assert.ok(userMsg, 'user message should be in messagesInner');
assert.equal(globalThis.__launchFlights.length, 1, 'sending should play exactly one launch flight');
const flight = globalThis.__launchFlights[0];
assert.equal(flight.element, userMsg, 'the flight must run on the echo element itself');
assert.equal(flight.options.duration, 380, 'flight duration should match the docked ascent timing');
assert.equal(
  flight.keyframes[0].transform,
  `translateY(${740 - 70}px) scale(0.96)`,
  'flight must start from the measured composer-to-bubble distance',
);
assert.equal(flight.keyframes.at(-1).transform, 'translateY(0) scale(1)', 'flight must end at the docked position with no fill state to unwind');

const pendingEl = context.messagesInner.children.find((c) => c.id === 'msgAssistantPending');
assert.ok(pendingEl, 'assistant pending presence should be right beneath user message');
assert.ok(
  pendingEl.className.includes('mobile-live-activity-line'),
  'the send window must reuse the live activity working row, not a skeleton card',
);
assert.equal(
  pendingEl.querySelector('.mobile-live-activity-line__dots')?.children.length,
  3,
  'the pending working row must carry the three-dot indicator',
);
assert.ok(
  pendingEl.querySelector('.mobile-live-activity-line__label'),
  'the pending working row must carry a text label',
);
assert.equal(
  context.messagesInner.children.indexOf(pendingEl),
  context.messagesInner.children.indexOf(userMsg) + 1,
  'the working row must sit directly beneath the user message',
);

const spacerEl = context.messagesInner.children.find((c) => c.id === 'turnViewportSpacer');
assert.ok(spacerEl, 'turnViewportSpacer should be at the end of messagesInner');
assert.ok(parseInt(spacerEl.style.height, 10) > 0, 'spacer height should be set');

// Test turn maintenance when send completes: spacer must persist and keep bubble docked at top!
userMsg.dataset.sendAwaitingCommit = 'true';
context.__api.syncComposerPendingTurnFeedback();
assert.ok(parseInt(spacerEl.style.height, 10) > 0, 'spacer height should persist and adapt after send completes to keep bubble docked');
assert.equal(context.messagesEl.scrollTop, Math.max(0, userMsg.offsetTop - 24), 'scrollTop should remain at targetScrollTop keeping bubble docked near top');

// Test when content grows and fills the screen height (turnHeightInViewport > clientH)
const longAssistantMsg = createMockElement('div');
longAssistantMsg.className = 'msg-assistant';
longAssistantMsg.offsetHeight = 850;
longAssistantMsg.offsetTop = userMsg.offsetTop + userMsg.offsetHeight;
// Insert before spacer
context.messagesInner.insertBefore(longAssistantMsg, spacerEl);

const growthResult = context.__api.syncTurnViewportSpacerOnGrowth();
assert.equal(growthResult.filledScreen, true, 'filledScreen should be true when output exceeds viewport height');
assert.equal(spacerEl.style.height, '0px', 'spacer should collapse to 0px once content fills the screen');
assert.equal(context.messagesEl.scrollTop, context.messagesEl.scrollHeight, 'auto-scroll should follow bottom once screen is filled, pushing history up');

console.log('test-chat-send-launch-to-top: ok');
