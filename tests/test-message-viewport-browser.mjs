#!/usr/bin/env node
import assert from 'assert/strict';
import { chromium } from '@playwright/test';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const helperSource = readFileSync(
  join(repoRoot, 'static/chat/session-http-helpers.js'),
  'utf8',
);

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.setContent(`
    <style>
      #messages { height: 400px; overflow-y: auto; }
      #messages.is-prepending-history { overflow-anchor: none; }
      .event { height: 500px; }
    </style>
    <div id="messages"><div id="messagesInner"></div></div>
    <div id="emptyState"></div>
  `);
  await page.addScriptTag({
    content: `
      const messagesEl = document.getElementById("messages");
      const messagesInner = document.getElementById("messagesInner");
      const emptyState = document.getElementById("emptyState");
      let currentSessionId = "session_browser";
      ${helperSource}
      window.testViewportApi = {
        captureMessageViewportAnchor,
        captureMessageViewportPrependState,
        restoreMessageViewportAfterPrepend,
        setMessageViewportPrependMode,
        restoreMessageViewportAnchor,
        syncMessageViewportStabilitySnapshot,
        scheduleMessageViewportLayoutRestore,
      };
    `,
  });

  const result = await page.evaluate(async () => {
    const render = () => {
      messagesInner.innerHTML = [1, 2, 3]
        .map((seq) => `<div class="event" data-timeline-start-seq="${seq}" data-timeline-end-seq="${seq}">event ${seq}</div>`)
        .join("");
    };
    render();
    messagesEl.scrollTop = 700;
    const anchor = window.testViewportApi.captureMessageViewportAnchor();
    const originalOffset = messagesInner.children[1].getBoundingClientRect().top
      - messagesEl.getBoundingClientRect().top;

    messagesInner.innerHTML = "";
    const clampedScrollTop = messagesEl.scrollTop;
    render();
    window.testViewportApi.restoreMessageViewportAnchor(anchor);
    const restoredOffset = messagesInner.children[1].getBoundingClientRect().top
      - messagesEl.getBoundingClientRect().top;

    const resizeState = window.testViewportApi.syncMessageViewportStabilitySnapshot();
    messagesInner.children[0].style.height = "680px";
    window.testViewportApi.scheduleMessageViewportLayoutRestore(resizeState);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const resizedOffset = messagesInner.children[1].getBoundingClientRect().top
      - messagesEl.getBoundingClientRect().top;
    const resizedScrollTop = messagesEl.scrollTop;

    // Prepending a real page must preserve the same visible item before the
    // browser gets a paint opportunity. This is the Web equivalent of the
    // Android LazyColumn item-index/offset restore.
    render();
    messagesEl.scrollTop = 700;
    const prependAnchor = window.testViewportApi.captureMessageViewportAnchor();
    const prependState = window.testViewportApi.captureMessageViewportPrependState({ anchor: prependAnchor });
    window.testViewportApi.setMessageViewportPrependMode(true);
    messagesInner.innerHTML = [0, 1, 2, 3]
      .map((seq) => `<div class="event" data-timeline-start-seq="${seq}" data-timeline-end-seq="${seq}">event ${seq}</div>`)
      .join("");
    const prependScrollTop = messagesEl.scrollTop;
    window.testViewportApi.restoreMessageViewportAfterPrepend(prependState);
    const immediatePrependScrollTop = messagesEl.scrollTop;
    const immediatePrependOffset = messagesInner.children[2].getBoundingClientRect().top
      - messagesEl.getBoundingClientRect().top;
    const prependOverflowAnchor = getComputedStyle(messagesEl).overflowAnchor;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.testViewportApi.setMessageViewportPrependMode(false);

    return {
      anchorSeq: anchor.nodeSeq,
      clampedScrollTop,
      restoredScrollTop: resizedScrollTop,
      originalOffset,
      restoredOffset,
      resizedOffset,
      prependScrollTop,
      immediatePrependScrollTop,
      immediatePrependOffset,
      prependOverflowAnchor,
    };
  });

  assert.equal(result.anchorSeq, 2);
  assert.equal(result.clampedScrollTop, 0, 'real DOM clearing should clamp the scroll container to the top');
  assert.equal(result.restoredOffset, result.originalOffset, 'reset restoration should preserve the visible event offset');
  assert.equal(result.resizedOffset, result.originalOffset, 'async content growth should preserve the visible event offset');
  assert.equal(result.restoredScrollTop, 880, 'layout growth above the anchor should be reflected in scrollTop');
  assert.equal(result.prependScrollTop, 700, 'disabling native anchoring should leave the pre-restore scroll position deterministic');
  assert.equal(result.immediatePrependScrollTop, 1200, 'prepend height delta should be compensated before the next paint');
  assert.equal(result.immediatePrependOffset, result.originalOffset, 'prepend should preserve the visible event offset');
  assert.equal(result.prependOverflowAnchor, 'none', 'prepend transaction should disable native double anchoring');
  console.log('test-message-viewport-browser: ok');
} finally {
  await browser.close();
}
