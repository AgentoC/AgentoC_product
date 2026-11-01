#!/usr/bin/env node
import assert from 'assert/strict';
import { readFile } from 'fs/promises';

import { chromium } from '@playwright/test';

const css = await readFile(new URL('../static/chat/custom-select.css', import.meta.url), 'utf8');
const js = await readFile(new URL('../static/chat/custom-select.js', import.meta.url), 'utf8');

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 520, height: 360 } });
  await page.setContent(`<!doctype html>
    <html>
      <head>
        <style>
          :root {
            --bg: #fff;
            --bg-secondary: #f8fafc;
            --bg-tertiary: #eef2f7;
            --border: #d7dbe3;
            --border-strong: #9da6b5;
            --modal-shadow: 0 12px 28px rgba(15, 23, 42, 0.18);
            --motion-fast: 0.12s;
            --motion-ease-out: ease-out;
            --text: #111827;
            --text-secondary: #334155;
            --text-muted: #8892a0;
          }
          body {
            margin: 0;
            font-family: system-ui, sans-serif;
          }
          .app-container {
            width: 480px;
            height: 136px;
            overflow: hidden;
            border: 1px solid #ccd2dc;
            position: relative;
          }
          .sidebar {
            width: 480px;
            height: 136px;
            overflow: hidden;
            transform: translateX(0);
            padding: 8px;
            box-sizing: border-box;
          }
          .sidebar-workspace {
            display: grid;
            grid-template-columns: auto minmax(0, 1fr);
            align-items: center;
            gap: 8px 10px;
          }
          ${css}
        </style>
      </head>
      <body>
        <div class="app-container">
          <aside class="sidebar">
            <div class="sidebar-workspace">
              <label for="workspaceSelect">工作区</label>
              <select id="workspaceSelect">
                <option>默认工作区</option>
                <option>自定义工作区</option>
                <option>另一个工作区</option>
              </select>
              <select id="workspaceCustomFolderSelect">
                <option>下面的下拉栏</option>
              </select>
            </div>
          </aside>
        </div>
        <script>${js}</script>
        <script>
          upgradeSelects('#workspaceSelect, #workspaceCustomFolderSelect', { className: 'cs-full cs-full-bg' });
        </script>
      </body>
    </html>`);

  await page.click('#workspaceSelect-cs-trigger');
  await page.waitForTimeout(100);

  const state = await page.evaluate(() => {
    const panel = document.querySelector('.custom-select-panel.is-open');
    const app = document.querySelector('.app-container');
    const panelRect = panel?.getBoundingClientRect();
    const appRect = app?.getBoundingClientRect();
    return {
      parentIsBody: panel?.parentNode === document.body,
      visible: !!panel && getComputedStyle(panel).display !== 'none',
      optionCount: panel?.querySelectorAll('.cs-option').length || 0,
      panelBottom: panelRect?.bottom || 0,
      appBottom: appRect?.bottom || 0,
    };
  });

  assert.equal(state.parentIsBody, true, 'custom select panel should be mounted to body while open');
  assert.equal(state.visible, true, 'custom select panel should be visible while open');
  assert.equal(state.optionCount, 3, 'custom select panel should preserve options after being floated');
  assert.ok(
    state.panelBottom > state.appBottom,
    'custom select panel should render outside a clipped sidebar container',
  );

  console.log('test-custom-select-floating-panel: ok');
} finally {
  await browser.close();
}
