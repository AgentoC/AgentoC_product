#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const helperSource = readFileSync(
  join(repoRoot, 'static/chat/session-http-helpers.js'),
  'utf8',
);

const animationFrames = [];
const messagesEl = {
  dataset: {},
  scrollTop: 700,
  scrollHeight: 1800,
  clientHeight: 400,
  listeners: new Map(),
  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  },
  getBoundingClientRect() {
    return { top: 0, bottom: this.clientHeight, height: this.clientHeight };
  },
};
const emptyState = {};
const messagesInner = {
  children: [],
};

function makeTimelineNode(seq, offsetTop, height = 500) {
  return {
    dataset: {
      timelineStartSeq: String(seq),
      timelineEndSeq: String(seq),
    },
    offsetTop,
    querySelector() {
      return null;
    },
    getBoundingClientRect() {
      const top = this.offsetTop - messagesEl.scrollTop;
      return { top, bottom: top + height, height };
    },
  };
}

messagesInner.children = [
  makeTimelineNode(1, 0),
  makeTimelineNode(2, 600),
  makeTimelineNode(3, 1200),
];

const context = {
  console,
  Date,
  Number,
  Math,
  Set,
  Array,
  messagesEl,
  messagesInner,
  emptyState,
  currentSessionId: 'session_test',
  requestAnimationFrame(callback) {
    animationFrames.push(callback);
    return animationFrames.length;
  },
  cancelAnimationFrame() {},
  ResizeObserver: class {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {}
  },
};
context.globalThis = context;
context.self = context;

vm.runInNewContext(helperSource, context, {
  filename: 'static/chat/session-http-helpers.js',
});

const anchor = context.captureMessageViewportAnchor();
assert.equal(anchor.nodeSeq, 2, 'the first visible timeline event should become the semantic anchor');
assert.equal(anchor.offsetFromViewportTop, -100);

messagesEl.scrollTop = 0;
messagesInner.children = [
  makeTimelineNode(1, 0),
  makeTimelineNode(2, 600),
  makeTimelineNode(3, 1200),
];
assert.equal(context.restoreMessageViewportAnchor(anchor), true);
assert.equal(messagesEl.scrollTop, 700, 'semantic restoration should recover the original reading position');

const asyncLayoutState = context.syncMessageViewportStabilitySnapshot();
messagesInner.children[0].offsetTop += 180;
messagesInner.children[1].offsetTop += 180;
messagesInner.children[2].offsetTop += 180;
messagesEl.scrollHeight += 180;
context.scheduleMessageViewportLayoutRestore(asyncLayoutState);
animationFrames.shift()();
assert.equal(
  messagesEl.scrollTop,
  880,
  'content growth above the anchor should be compensated without moving the visible message',
);

// An older page is committed in one synchronous transaction. The equivalent
// of Android LazyColumn's first-visible-item restore must account for the
// inserted height immediately, then keep the semantic anchor available for
// the next layout frame.
messagesEl.scrollTop = 700;
messagesEl.scrollHeight = 1800;
messagesInner.children = [
  makeTimelineNode(1, 0),
  makeTimelineNode(2, 600),
  makeTimelineNode(3, 1200),
];
const prependAnchor = context.captureMessageViewportAnchor();
const prependState = context.captureMessageViewportPrependState({ anchor: prependAnchor });
context.setMessageViewportPrependMode(true);
messagesInner.children = [
  makeTimelineNode(0, 0),
  makeTimelineNode(1, 600),
  makeTimelineNode(2, 1200),
  makeTimelineNode(3, 1800),
];
messagesEl.scrollHeight = 2400;
assert.equal(context.restoreMessageViewportAfterPrepend(prependState), true);
assert.equal(messagesEl.scrollTop, 1300, 'prepend compensation should preserve the visible item in the same frame');
animationFrames.shift()();
context.setMessageViewportPrependMode(false);

const staleAnchor = context.captureMessageViewportAnchor();
context.markMessageViewportUserIntent();
context.handleMessageViewportScroll();
messagesEl.scrollTop = 0;
assert.equal(
  context.restoreMessageViewportAnchor(staleAnchor),
  false,
  'an anchor captured before user scrolling must not override the newer user position',
);
assert.equal(messagesEl.scrollTop, 0);

// There is no multi-frame anchor lock. A user scroll invalidates the one
// captured semantic anchor, while a programmatic restore remains ignored by
// the scroll listener for the short write window.
const freshAnchor = context.captureMessageViewportAnchor();
context.markMessageViewportProgrammaticScroll();
context.handleMessageViewportScroll();
assert.equal(
  context.restoreMessageViewportAnchor(freshAnchor),
  true,
  'the current semantic anchor can still be restored after a programmatic scroll',
);

// Multiple ResizeObserver reports in one frame coalesce to one restore, but
// the callback must consume the newest semantic state rather than its first
// closure argument.
messagesEl.scrollTop = 0;
const currentAnchor = context.captureMessageViewportAnchor();
const olderState = {
  sessionId: 'session_test',
  stickyBottom: false,
  anchor: { ...currentAnchor, offsetFromViewportTop: 20 },
};
const newestState = {
  sessionId: 'session_test',
  stickyBottom: false,
  anchor: { ...currentAnchor, offsetFromViewportTop: currentAnchor.offsetFromViewportTop },
};
context.scheduleMessageViewportLayoutRestore(olderState);
context.scheduleMessageViewportLayoutRestore(newestState);
assert.equal(animationFrames.length, 1, 'same-frame restores should remain single-flight');
animationFrames.shift()();
assert.equal(messagesEl.scrollTop, 0, 'the newest same-frame anchor should win');

console.log('test-message-viewport-stability: ok');
