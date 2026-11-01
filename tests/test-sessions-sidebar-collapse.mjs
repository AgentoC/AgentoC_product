#!/usr/bin/env node
import assert from 'assert/strict';
import { readFile } from 'fs/promises';

import { chromium } from '@playwright/test';

const baseCss = await readFile(new URL('../static/chat/chat-base.css', import.meta.url), 'utf8');
const sidebarCss = await readFile(new URL('../static/chat/chat-sidebar.css', import.meta.url), 'utf8');
const responsiveCss = await readFile(new URL('../static/chat/chat-responsive.css', import.meta.url), 'utf8');

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 720 } });
  await page.setContent(`<!doctype html>
    <html>
      <head>
        <style>${baseCss}\n${sidebarCss}\n${responsiveCss}</style>
      </head>
      <body>
        <div class="header">
          <button class="header-btn header-btn--sessions" id="menuBtn">Sessions</button>
        </div>
        <div class="app-container">
          <div class="sidebar-overlay" id="sidebarOverlay">
            <aside class="sidebar" id="sidebar">
              <div class="sidebar-tabs" id="sidebarTabs">
                <button class="sidebar-tab active">Sessions</button>
                <button class="sidebar-tab">Agent</button>
                <button class="sidebar-tab">Settings</button>
              </div>
              <button class="header-btn sidebar-close-btn" id="closeSidebar">Back</button>
            </aside>
          </div>
          <main class="chat-area"></main>
        </div>
        <script>
          closeSidebar.addEventListener('click', () => {
            document.body.classList.add('sessions-sidebar-collapsed');
          });
        </script>
      </body>
    </html>`);

  const toPxNumber = (value) => Number.parseFloat(String(value).replace('px', ''));
  const assertClose = (actual, expected, message) => {
    assert.ok(
      Math.abs(actual - expected) < 0.5,
      `${message}: expected ${expected}px, got ${actual}px`,
    );
  };

  const expanded = await page.evaluate(() => ({
    menuDisplay: getComputedStyle(document.getElementById('menuBtn')).display,
    headerMarginLeft: getComputedStyle(document.querySelector('.header')).marginLeft,
    appMarginLeft: getComputedStyle(document.querySelector('.app-container')).marginLeft,
    closeDisplay: getComputedStyle(document.getElementById('closeSidebar')).display,
    closeOpacity: getComputedStyle(document.getElementById('closeSidebar')).opacity,
    closePointerEvents: getComputedStyle(document.getElementById('closeSidebar')).pointerEvents,
    overlayWidth: getComputedStyle(document.getElementById('sidebarOverlay')).width,
    overlayTransform: getComputedStyle(document.getElementById('sidebarOverlay')).transform,
  }));

  assert.equal(expanded.menuDisplay, 'none', 'desktop sessions button should stay hidden while sidebar is expanded');
  assert.equal(expanded.headerMarginLeft, expanded.overlayWidth, 'expanded desktop header should reserve sidebar width');
  assert.equal(expanded.appMarginLeft, expanded.overlayWidth, 'expanded desktop app should reserve sidebar width');
  assert.notEqual(expanded.closeDisplay, 'none', 'desktop sidebar should keep the hover collapse control mounted');
  assert.equal(expanded.closeOpacity, '0', 'desktop sidebar collapse control should start hidden before hover');
  assert.equal(expanded.closePointerEvents, 'none', 'hidden desktop sidebar collapse control should not intercept clicks');
  assert.equal(expanded.overlayTransform, 'matrix(1, 0, 0, 1, 0, 0)', 'expanded desktop sidebar should be onscreen');

  await page.hover('#sidebar');
  await page.waitForTimeout(280);
  const hovered = await page.evaluate(() => {
    const close = document.getElementById('closeSidebar');
    const overlay = document.getElementById('sidebarOverlay');
    const tabs = document.getElementById('sidebarTabs');
    const closeRect = close.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const tabsRect = tabs.getBoundingClientRect();
    return {
      closeOpacity: Number.parseFloat(getComputedStyle(close).opacity),
      closePointerEvents: getComputedStyle(close).pointerEvents,
      closeBorderRadius: getComputedStyle(close).borderRadius,
      closeLeft: closeRect.left,
      closeRight: closeRect.right,
      closeCenterY: closeRect.top + (closeRect.height / 2),
      overlayWidth: getComputedStyle(overlay).width,
      overlayRight: overlayRect.right,
      tabsRight: tabsRect.right,
      tabsCenterY: tabsRect.top + (tabsRect.height / 2),
    };
  });

  assert.ok(hovered.closeOpacity > 0.98, 'desktop sidebar collapse control should become visible on sidebar hover');
  assert.equal(hovered.closePointerEvents, 'auto', 'visible desktop sidebar collapse control should be clickable');
  assert.equal(hovered.closeBorderRadius, '10px', 'desktop sidebar collapse control should render as a normal button inside the expanded panel');
  assertClose(toPxNumber(hovered.overlayWidth), toPxNumber(expanded.overlayWidth) + 48, 'desktop sidebar should widen on hover to reveal the collapse control');
  assert.ok(hovered.closeLeft > hovered.tabsRight, 'desktop sidebar collapse control should appear to the right of the top tab row');
  assert.ok(hovered.closeRight < hovered.overlayRight, 'desktop sidebar collapse control should stay inside the widened sidebar panel');
  assertClose(hovered.closeCenterY, hovered.tabsCenterY, 'desktop sidebar collapse control should vertically align with the top tab row center');

  await page.click('#closeSidebar');
  await page.waitForTimeout(320);
  const collapsed = await page.evaluate(() => ({
    bodyCollapsed: document.body.classList.contains('sessions-sidebar-collapsed'),
    menuDisplay: getComputedStyle(document.getElementById('menuBtn')).display,
    headerMarginLeft: getComputedStyle(document.querySelector('.header')).marginLeft,
    appMarginLeft: getComputedStyle(document.querySelector('.app-container')).marginLeft,
    headerWidth: getComputedStyle(document.querySelector('.header')).width,
    viewportWidth: window.innerWidth,
    overlayPointerEvents: getComputedStyle(document.getElementById('sidebarOverlay')).pointerEvents,
    overlayTransform: getComputedStyle(document.getElementById('sidebarOverlay')).transform,
    overlayTranslateX: new DOMMatrixReadOnly(getComputedStyle(document.getElementById('sidebarOverlay')).transform).m41,
  }));

  assert.equal(collapsed.bodyCollapsed, true, 'clicking the hover back control should collapse the desktop sidebar');
  assert.equal(collapsed.menuDisplay, 'flex', 'desktop sessions button should reopen the collapsed sidebar');
  assert.equal(collapsed.headerMarginLeft, '0px', 'collapsed desktop header should use the full width');
  assert.equal(collapsed.appMarginLeft, '0px', 'collapsed desktop app should use the full width');
  assertClose(toPxNumber(collapsed.headerWidth), collapsed.viewportWidth, 'collapsed desktop header should expand across the viewport');
  assert.equal(collapsed.overlayPointerEvents, 'none', 'collapsed sidebar should not intercept clicks');
  assertClose(collapsed.overlayTranslateX, -toPxNumber(expanded.overlayWidth), 'collapsed sidebar should slide offscreen');

  console.log('test-sessions-sidebar-collapse: ok');
} finally {
  await browser.close();
}
