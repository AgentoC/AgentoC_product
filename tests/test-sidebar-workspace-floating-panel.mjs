#!/usr/bin/env node
import assert from 'assert/strict';
import { readFile } from 'fs/promises';

import { chromium } from '@playwright/test';

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const paramsStart = source.indexOf('(', start);
  assert.notEqual(paramsStart, -1, `${functionName} should have parameters`);
  let braceStart = -1;
  let depth = 0;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      if (braceStart === -1) braceStart = index;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (braceStart !== -1 && depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`${functionName} source was not closed`);
}

const customSelectCss = await readFile(new URL('../static/chat/custom-select.css', import.meta.url), 'utf8');
const customSelectJs = await readFile(new URL('../static/chat/custom-select.js', import.meta.url), 'utf8');
const sidebarUiSource = await readFile(new URL('../static/chat/sidebar-ui.js', import.meta.url), 'utf8');

const workspacePanelTargetSource = [
  extractFunctionSource(sidebarUiSource, 'getWorkspacePickerElement'),
  extractFunctionSource(sidebarUiSource, 'isWorkspaceFloatingPanelTarget'),
  'window.__isWorkspaceFloatingPanelTarget = isWorkspaceFloatingPanelTarget;',
].join('\n\n');

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 520, height: 420 } });
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
          .sidebar-workspace {
            width: 320px;
            display: grid;
            gap: 8px;
            padding: 12px;
          }
          ${customSelectCss}
        </style>
      </head>
      <body>
        <div class="sidebar-workspace is-expanded" id="workspacePicker">
          <select id="workspaceSelect">
            <option value="default">默认工作区</option>
            <option value="custom">自定义工作区</option>
          </select>
          <select id="workspaceCustomFolderSelect">
            <option value="/workspace/a">/workspace/a</option>
            <option value="/workspace/b">/workspace/b</option>
          </select>
          <div class="sidebar-workspace-browser" id="workspaceBrowser">
            <select id="workspaceBrowserSelect">
              <option value="/workspace/a/app">app</option>
              <option value="/workspace/a/docs">docs</option>
            </select>
          </div>
        </div>
        <script>${customSelectJs}</script>
        <script>
          upgradeSelects('#workspaceSelect, #workspaceCustomFolderSelect, #workspaceBrowserSelect', { className: 'cs-full cs-full-bg' });
          ${workspacePanelTargetSource}
        </script>
      </body>
    </html>`);

  async function openAndCheck(triggerSelector) {
    await page.click(triggerSelector);
    await page.waitForTimeout(80);
    const state = await page.evaluate(() => {
      const panel = document.querySelector('.custom-select-panel.is-open');
      const option = panel?.querySelector('.cs-option');
      return {
        parentIsBody: panel?.parentNode === document.body,
        labelledBy: panel?.getAttribute('aria-labelledby') || '',
        isWorkspaceTarget: window.__isWorkspaceFloatingPanelTarget(option),
      };
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(160);
    return state;
  }

  const modePanel = await openAndCheck('#workspaceSelect-cs-trigger');
  assert.equal(modePanel.parentIsBody, true, 'workspace mode panel should float to body');
  assert.equal(modePanel.isWorkspaceTarget, true, 'workspace mode floating panel should count as workspace interaction');

  const customFolderPanel = await openAndCheck('#workspaceCustomFolderSelect-cs-trigger');
  assert.equal(customFolderPanel.parentIsBody, true, 'custom folder panel should float to body');
  assert.equal(customFolderPanel.isWorkspaceTarget, true, 'custom folder floating panel should count as workspace interaction');

  const browserPanel = await openAndCheck('#workspaceBrowserSelect-cs-trigger');
  assert.equal(browserPanel.parentIsBody, true, 'workspace browser panel should float to body');
  assert.equal(browserPanel.labelledBy, 'workspaceBrowserSelect-cs-trigger');
  assert.equal(browserPanel.isWorkspaceTarget, true, 'workspace browser floating panel should count as workspace interaction');

  console.log('test-sidebar-workspace-floating-panel: ok');
} finally {
  await browser.close();
}
