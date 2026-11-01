#!/usr/bin/env node
import assert from 'assert/strict';
import { readFile } from 'fs/promises';

import { chromium } from '@playwright/test';

const css = await readFile(new URL('../static/chat/chat-sidebar.css', import.meta.url), 'utf8');

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 480, height: 240 } });
  await page.setContent(`<!doctype html>
    <html>
      <head>
        <style>
          :root {
            --bg: #fff;
            --bg-secondary: #f8fafc;
            --border: #d7dbe3;
            --text: #111827;
            --text-muted: #8892a0;
          }
          ${css}
        </style>
      </head>
      <body>
        <div class="sidebar-workspace">
          <div class="sidebar-section-title">工作区</div>
          <div class="sidebar-workspace-form">
            <select class="sidebar-workspace-select"><option>默认工作区</option></select>
          </div>
          <div class="sidebar-workspace-custom" id="workspaceCustomPicker" hidden>
            <select class="sidebar-workspace-select"><option>选择路径</option></select>
          </div>
        </div>
      </body>
    </html>`);

  const display = await page.locator('#workspaceCustomPicker').evaluate((node) => getComputedStyle(node).display);
  assert.equal(display, 'none', 'custom workspace path picker should stay hidden in default workspace mode');
  console.log('test-sidebar-workspace-hidden: ok');
} finally {
  await browser.close();
}
