#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// Regression guard for the mobile bottom action bar layout: the primary
// action stays on the left, Agent is a compact symbol control, and the primary
// action remains prominent while Settings/account stay pinned right.

const [css, responsiveCss] = await Promise.all([
  readFile(new URL('../static/chat/chat-sidebar.css', import.meta.url), 'utf8'),
  readFile(new URL('../static/chat/chat-responsive.css', import.meta.url), 'utf8'),
]);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(`<!doctype html><html><body>
  <div class="sidebar" id="sidebar" style="position:relative;width:100vw;height:200px;">
  <div class="sidebar-bottom-actions" id="sidebarBottomActions">
    <button class="new-session-btn sidebar-new-chat-btn"><span class="sidebar-new-chat-icon"></span><span>Sessions</span></button>
    <button class="sidebar-agent-btn" id="sidebarAgentBtn"><span class="sidebar-agent-icon"></span></button>
    <button class="sidebar-filter-btn" id="sidebarFilterBtn"></button>
    <button class="sidebar-account-btn" id="sidebarAccountBtn"><span class="sidebar-account-avatar">A</span></button>
  </div>
</div></body></html>`);
  await page.addStyleTag({ content: css + responsiveCss + ':root{--safe-bottom:0px;--accent:#000;--bg-secondary:#fff;--text:#000;--bg-primary:#fff;}' });

  const measure = () => page.evaluate(() => {
    const bar = document.getElementById('sidebarBottomActions').getBoundingClientRect();
    const newChat = document.querySelector('.sidebar-new-chat-btn').getBoundingClientRect();
    const acc = document.getElementById('sidebarAccountBtn').getBoundingClientRect();
    const filt = document.getElementById('sidebarFilterBtn').getBoundingClientRect();
    const pill = document.getElementById('sidebarAgentBtn').getBoundingClientRect();
    const style = getComputedStyle(document.getElementById('sidebarAgentBtn'));
    const newChatStyle = getComputedStyle(document.querySelector('.sidebar-new-chat-btn'));
    return {
      barRight: bar.right,
      accRight: acc.right,
      newChat,
      filtW: filt.width,
      filtRight: filt.right,
      filtLeft: filt.left,
      filtTop: filt.top,
      accTop: acc.top,
      pill,
      pillRadius: style.borderRadius,
      pillHeight: pill.height,
      newChatRadius: newChatStyle.borderRadius,
    };
  });

  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const layout = await measure();
    assert.ok(layout.filtW > 0, `${width}px: settings entry button is laid out when visible`);
    assert.ok(
      layout.barRight - layout.accRight <= 2,
      `${width}px: account should be right-aligned in the bar (gap ${layout.barRight - layout.accRight})`,
    );
    assert.ok(layout.filtRight <= layout.accRight, `${width}px: settings entry should sit left of the account button`);
    assert.equal(layout.pillHeight, 48, `${width}px: Agent control should share the unified 48px height`);
    assert.equal(layout.newChat.height, 52, `${width}px: primary action should be 52px tall`);
    assert.equal(layout.newChatRadius, '26px', `${width}px: primary action should stay capsule-shaped on mobile`);
    assert.equal(layout.filtTop, layout.accTop, `${width}px: Settings and account should share the bottom row baseline`);
    assert.equal(layout.pillRadius, '50%', `${width}px: Agent symbol control should be circular`);
    assert.ok(layout.pill.right <= layout.filtLeft + 1, `${width}px: agent action should precede Settings`);
    assert.ok(layout.pill.top >= layout.accTop - 1, `${width}px: agent action should share the bottom row`);
    assert.ok(!overlaps(layout.newChat, layout.pill), `${width}px: New session and Agent should not overlap`);
    assert.ok(!overlaps(layout.pill, { left: layout.filtLeft, right: layout.filtRight, top: layout.filtTop, bottom: layout.filtTop + 48 }), `${width}px: Agent and Settings should not overlap`);
    assert.ok(layout.filtLeft - layout.pill.right >= 6, `${width}px: L2 should leave breathing room before Settings`);
  }

  console.log('test-chat-sidebar-bottom-actions-layout: ok');
} finally {
  await browser.close();
}
