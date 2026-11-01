#!/usr/bin/env node
// Browser contract for the mobile sessions drawer exit: the backdrop must
// fade while the panel slides, and visibility must not hide the panel before
// that motion has completed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const css = await Promise.all([
  readFile(new URL('../static/chat/chat-base.css', import.meta.url), 'utf8'),
  readFile(new URL('../static/chat/chat-sidebar.css', import.meta.url), 'utf8'),
  readFile(new URL('../static/chat/chat-responsive.css', import.meta.url), 'utf8'),
]);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(`
    <style>${css.join('\n')}</style>
    <div class="app-shell"><div class="app-container">
      <div class="sidebar-overlay open" id="sidebarOverlay">
        <aside class="sidebar"><div style="height: 200px">Sessions</div></aside>
      </div>
    </div></div>
  `);

  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  await page.evaluate(() => {
    const overlay = document.getElementById('sidebarOverlay');
    overlay.classList.remove('open');
    overlay.classList.add('is-closing');
  });
  await page.waitForTimeout(60);

  const midClose = await page.evaluate(() => {
    const overlay = document.getElementById('sidebarOverlay');
    const sidebar = overlay.querySelector('.sidebar');
    const overlayStyle = getComputedStyle(overlay);
    const sidebarStyle = getComputedStyle(sidebar);
    return {
      transition: overlayStyle.transition,
      opacity: Number(overlayStyle.opacity),
      visibility: overlayStyle.visibility,
      sidebarTransform: sidebarStyle.transform,
    };
  });
  assert.match(midClose.transition, /opacity/, 'drawer overlay should own an opacity transition');
  assert.ok(midClose.opacity < 0.98, 'drawer overlay should be fading during close');
  assert.equal(midClose.visibility, 'visible', 'drawer must remain paintable during close');
  assert.notEqual(midClose.sidebarTransform, 'matrix(1, 0, 0, 1, -390, 0)',
    'drawer panel should still be moving during the close window');

  await page.waitForTimeout(220);
  await page.evaluate(() => document.getElementById('sidebarOverlay').classList.remove('is-closing'));
  const settled = await page.evaluate(() => {
    const overlay = document.getElementById('sidebarOverlay');
    const style = getComputedStyle(overlay);
    return { visibility: style.visibility, pointerEvents: style.pointerEvents };
  });
  assert.equal(settled.visibility, 'hidden', 'drawer should become hidden after the exit motion');
  assert.equal(settled.pointerEvents, 'none', 'closed drawer should not intercept input');
  console.log('test-chat-sidebar-drawer-motion: ok');
} finally {
  await browser.close();
}
