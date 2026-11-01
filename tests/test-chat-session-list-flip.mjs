#!/usr/bin/env node
// Browser-level FLIP tests for the session list: the list rebuilds in place
// on every state change, and items that exist in both the old and the new
// snapshot are held at their previous visual position, then transitioned to
// their new one. These tests drive the real session-list-ui.js /
// session-surface-ui.js / motion.js scripts with stubbed sidebar globals and
// assert the skip conditions (first render, reduced motion, hidden container,
// session switch) and the no-residue guarantee.
import assert from 'assert/strict';
import { chromium } from '@playwright/test';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const readAsset = (name) => readFileSync(join(repoRoot, 'static', 'chat', name), 'utf8');
const motionSource = readAsset('motion.js');
const surfaceSource = readAsset('session-surface-ui.js');
const listSource = readAsset('session-list-ui.js');

// Globals renderSessionList / createActiveSessionItem depend on that are not
// defined by the loaded scripts themselves. getVisible*Sessions return the
// mutable test state; compareSessionListSessions preserves array order so the
// test controls the rendered order directly.
const REDUCED_MOTION_STUB = `
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: function () {
      return {
        matches: true,
        media: "(prefers-reduced-motion: reduce)",
        onchange: null,
        addListener: function () {},
        removeListener: function () {},
        addEventListener: function () {},
        removeEventListener: function () {},
        dispatchEvent: function () { return false; },
      };
    },
  });
`;

const STUB_SETUP = `
  // about:blank documents deny real localStorage access; the archived section
  // header only reads/writes the archivedCollapsed key.
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: function () { return null; },
      setItem: function () {},
    },
  });
  window.__flipState = { pinned: [], active: [], archived: [] };
  window.sessionList = document.getElementById("sessionList");
  window.currentSessionId = null;
  window.visitorMode = false;
  window.isDesktop = true;
  window.closeSidebarFn = function () {};
  window.dispatchAction = function () {};
  window.fetchArchivedSessions = function () { return Promise.resolve(); };
  window.archivedSessionsLoaded = false;
  window.archivedSessionsLoading = false;
  window.archivedSessionCount = 0;
  window.restoreOwnerBootstrapSessions = function () {};
  window.renderUiIcon = function () { return ""; };
  window.compareSessionListSessions = function () { return 0; };
  window.getSessionStatusSummary = function () {
    return { primary: { key: "idle", label: "Idle", title: "Idle" } };
  };
  window.getVisiblePinnedSessions = function () { return window.__flipState.pinned; };
  window.getVisibleActiveSessions = function () { return window.__flipState.active; };
  window.getVisibleArchivedSessions = function () { return window.__flipState.archived; };
  window.__flipTest = {
    sessions: function (ids) {
      return ids.map(function (id, index) {
        return {
          id: id,
          name: id.toUpperCase(),
          created: "2026-08-0" + (index + 1) + "T00:00:00.000Z",
          updatedAt: "2026-08-05T12:34:00.000Z",
        };
      });
    },
    render: function () { renderSessionList(); },
    transforms: function () {
      return Array.from(document.querySelectorAll("#sessionList .session-item")).map(function (el) {
        return {
          id: el.getAttribute("data-session-id"),
          transform: el.style.transform,
          transition: el.style.transition,
        };
      });
    },
  };
`;

async function withPage(run, { reducedMotion = false } = {}) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.setContent(`
      <style>
        #sessionList { width: 260px; }
        .session-item {
          width: 100%;
          height: 32px;
          display: flex;
          align-items: center;
          box-sizing: border-box;
          margin: 0;
          padding: 0;
          border: 0;
        }
      </style>
      <div id="sessionList"></div>
    `);
    // The reduced-motion stub must be in place before the real motion.js loads
    // (its IIFE snapshots matchMedia at load time).
    if (reducedMotion) await page.addScriptTag({ content: REDUCED_MOTION_STUB });
    await page.addScriptTag({ content: STUB_SETUP });
    await page.addScriptTag({ content: motionSource });
    await page.addScriptTag({ content: surfaceSource });
    await page.addScriptTag({ content: listSource });
    await run(page);
  } finally {
    await browser.close();
  }
}

// --- 1. First render: no animation, no transform residue, ids present ---
await withPage(async (page) => {
  const result = await page.evaluate(() => {
    window.__flipState.active = window.__flipTest.sessions(['s-a', 's-b', 's-c']);
    // Session archival was removed in 29af1c2. Keep an archived fixture here
    // to prove the current permanent-delete list does not resurrect it.
    window.__flipState.archived = [{ id: 's-arch', name: 'ARCH', updatedAt: '2026-08-05T12:34:00.000Z' }];
    window.archivedSessionsLoaded = true;
    window.archivedSessionCount = 1;
    window.__flipTest.render();
    return {
      ids: Array.from(document.querySelectorAll('#sessionList .session-item'))
        .map((el) => el.getAttribute('data-session-id')),
      tags: Array.from(document.querySelectorAll('#sessionList .session-item'))
        .map((el) => el.tagName),
      interactiveTags: Array.from(document.querySelectorAll(
        '#sessionList .pinned-items .session-item, #sessionList .folder-group-items .session-item, #sessionList .archived-items .session-item-main',
      )).map((el) => el.tagName),
      times: Array.from(document.querySelectorAll('#sessionList .session-item-time'))
        .map((el) => el.textContent.trim()),
      transforms: window.__flipTest.transforms(),
    };
  });
  assert.deepEqual(
    result.ids,
    ['s-a', 's-b', 's-c'],
    'the permanent-delete session list should render only active items for FLIP matching',
  );
  assert.ok(result.interactiveTags.every((tag) => tag === 'BUTTON'), 'interactive session items should use native button semantics');
  const archivedSectionPresent = await page.evaluate(
    () => document.querySelector('#archivedSection') !== null,
  );
  assert.equal(archivedSectionPresent, false, 'archived section should remain removed');
  assert.ok(result.times.every((time) => time.length > 0), 'updated sessions should render a compact time slot');
  assert.ok(
    result.transforms.every((entry) => entry.transform === '' && entry.transition === ''),
    'first render should not apply any FLIP transform',
  );
  await page.waitForTimeout(320);
  const settled = await page.evaluate(() => window.__flipTest.transforms());
  assert.ok(
    settled.every((entry) => entry.transform === '' && entry.transition === ''),
    'no transform/transition residue should remain after the first render',
  );
  console.log('flip: first render + data-session-id: ok');
});

// --- 2. Reorder: matched items animate, then settle to zero ---
await withPage(async (page) => {
  await page.evaluate(() => {
    window.__flipState.active = window.__flipTest.sessions(['s-a', 's-b', 's-c']);
    window.__flipTest.render();
  });
  await page.evaluate(() => {
    window.__flipTest.transitionRuns = [];
    sessionList.addEventListener('transitionrun', (event) => {
      if (event.propertyName !== 'transform') return;
      window.__flipTest.transitionRuns.push(event.target.getAttribute('data-session-id'));
    }, true);
  });
  await page.evaluate(() => {
    window.__flipState.active = window.__flipTest.sessions(['s-c', 's-b', 's-a']);
    window.__flipTest.render();
  });
  // The inverse transform is applied synchronously inside the rebuild call.
  const immediate = await page.evaluate(() => window.__flipTest.transforms());
  assert.ok(
    immediate.some((entry) => entry.transform !== ''),
    'reordered items should hold an inverse transform right after the rebuild',
  );
  assert.ok(
    immediate.every(
      (entry) => entry.id === 's-b' || entry.transform === 'translate(0px, 0px)'
        || /^translate\((-?[0-9.]+)px, (-?[0-9.]+)px\)$/.test(entry.transform),
    ),
    'inverse transforms should be plain translate() values',
  );
  // One frame later the transition should still be in flight.
  const mid = await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve(window.__flipTest.transforms()));
    });
  }));
  assert.ok(
    mid.some((entry) => entry.transform !== ''),
    'matched items should still be moving inside the FLIP window',
  );
  // The animation must actually play: transitionrun proves the browser
  // observed the inverse offset as the transition start state. This is more
  // stable than sampling a fixed wall-clock point inside the 150ms window.
  await page.waitForFunction(() => window.__flipTest.transitionRuns.length > 0);
  const transitionRuns = await page.evaluate(() => window.__flipTest.transitionRuns);
  assert.ok(
    transitionRuns.includes('s-a') && transitionRuns.includes('s-c'),
    'matched items should emit a transform transitionrun event',
  );
  await page.waitForTimeout(400);
  const settled = await page.evaluate(() => window.__flipTest.transforms());
  assert.ok(
    settled.every((entry) => entry.transform === '' && entry.transition === ''),
    'FLIP should clear all inline transform/transition styles when done',
  );
  console.log('flip: reorder animation + cleanup: ok');
});

// --- 3. Reduced motion: jump straight to the final state ---
await withPage(async (page) => {
  await page.evaluate(() => {
    window.__flipState.active = window.__flipTest.sessions(['s-a', 's-b', 's-c']);
    window.__flipTest.render();
  });
  await page.evaluate(() => {
    window.__flipState.active = window.__flipTest.sessions(['s-c', 's-b', 's-a']);
    window.__flipTest.render();
  });
  const immediate = await page.evaluate(() => window.__flipTest.transforms());
  assert.ok(
    immediate.every((entry) => entry.transform === '' && entry.transition === ''),
    'reduced-motion renders should skip the FLIP transform entirely',
  );
  await page.waitForTimeout(320);
  const settled = await page.evaluate(() => window.__flipTest.transforms());
  assert.ok(
    settled.every((entry) => entry.transform === '' && entry.transition === ''),
    'reduced-motion should leave no transform residue',
  );
  console.log('flip: reduced-motion skip: ok');
}, { reducedMotion: true });

// --- 4. Hidden container: no animation ---
await withPage(async (page) => {
  await page.evaluate(() => {
    window.__flipState.active = window.__flipTest.sessions(['s-a', 's-b', 's-c']);
    window.__flipTest.render();
  });
  await page.evaluate(() => {
    document.getElementById('sessionList').style.display = 'none';
    window.__flipState.active = window.__flipTest.sessions(['s-c', 's-b', 's-a']);
    window.__flipTest.render();
    document.getElementById('sessionList').style.display = '';
  });
  const immediate = await page.evaluate(() => window.__flipTest.transforms());
  assert.ok(
    immediate.every((entry) => entry.transform === '' && entry.transition === ''),
    'hidden container (zero-size rect) should skip the FLIP transform',
  );
  await page.waitForTimeout(320);
  const settled = await page.evaluate(() => window.__flipTest.transforms());
  assert.ok(
    settled.every((entry) => entry.transform === '' && entry.transition === ''),
    'hidden-container render should leave no transform residue',
  );
  console.log('flip: hidden container skip: ok');
});

// --- 5. New items never take part in the FLIP ---
await withPage(async (page) => {
  await page.evaluate(() => {
    window.__flipState.active = window.__flipTest.sessions(['s-a', 's-b', 's-c']);
    window.__flipTest.render();
  });
  await page.evaluate(() => {
    window.__flipState.active = window.__flipTest.sessions(['s-new', 's-a', 's-b', 's-c']);
    window.__flipTest.render();
  });
  const immediate = await page.evaluate(() => window.__flipTest.transforms());
  const newEntry = immediate.find((entry) => entry.id === 's-new');
  assert.ok(newEntry, 'new item should exist in the rebuilt list');
  assert.equal(
    newEntry.transform,
    '',
    'a brand-new item should never receive a FLIP transform',
  );
  assert.ok(
    immediate.some((entry) => entry.id !== 's-new' && entry.transform !== ''),
    'existing items pushed down by the insertion should still animate',
  );
  await page.waitForTimeout(400);
  const settled = await page.evaluate(() => window.__flipTest.transforms());
  assert.ok(
    settled.every((entry) => entry.transform === '' && entry.transition === ''),
    'new-item insert should leave no transform residue',
  );
  console.log('flip: new item excluded: ok');
});

// --- 6. Session switch: skip the FLIP ---
await withPage(async (page) => {
  await page.evaluate(() => {
    window.currentSessionId = 's-a';
    window.__flipState.active = window.__flipTest.sessions(['s-a', 's-b', 's-c']);
    window.__flipTest.render();
  });
  await page.evaluate(() => {
    window.currentSessionId = 's-b';
    window.__flipState.active = window.__flipTest.sessions(['s-c', 's-b', 's-a']);
    window.__flipTest.render();
  });
  const immediate = await page.evaluate(() => window.__flipTest.transforms());
  assert.ok(
    immediate.every((entry) => entry.transform === '' && entry.transition === ''),
    'a render across a session switch should not FLIP',
  );
  await page.waitForTimeout(320);
  const settled = await page.evaluate(() => window.__flipTest.transforms());
  assert.ok(
    settled.every((entry) => entry.transform === '' && entry.transition === ''),
    'session-switch render should leave no transform residue',
  );
  console.log('flip: session switch skip: ok');
});

console.log('test-chat-session-list-flip: ok');
