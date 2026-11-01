#!/usr/bin/env node
// The mobile transcript should use the same message geometry and typography as
// desktop, while its user bubble intentionally uses a flat material treatment.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-messages.css',
  'static/chat/chat-responsive.css',
  'static/chat/chat-glass.css',
  'static/chat/chat-m3-tokens.css',
  'static/chat/chat-m3-components.css',
  'static/chat/chat-material-finish.css',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');

const selectors = ['.msg-user', '.msg-user-bubble', '.msg-assistant'];
const visualProperties = [
  'marginBottom',
  'maxWidth',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomRightRadius',
  'borderBottomLeftRadius',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'backgroundColor',
  'backgroundImage',
  'color',
  'boxShadow',
  'fontSize',
  'lineHeight',
  'backdropFilter',
];

const html = `<!doctype html>
<html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head>
<body><main class="messages"><div class="messages-inner">
  <div class="msg-user"><div class="msg-user-bubble"><span class="md-content">一条用户消息</span></div></div>
  <div class="msg-assistant"><div class="msg-assistant-body">一条助手消息</div></div>
</div></main></body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  const measurements = {};
  for (const viewport of [
    { name: 'desktop', width: 1200, height: 800 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport, colorScheme: 'light' });
    await page.setContent(html, { waitUntil: 'load' });
    measurements[viewport.name] = await page.evaluate(({ selectors, visualProperties }) => {
      return Object.fromEntries(selectors.map((selector) => {
        const computed = getComputedStyle(document.querySelector(selector));
        return [selector, Object.fromEntries(visualProperties.map((property) => [property, computed[property]]))];
      }));
    }, { selectors, visualProperties });
    await page.close();
  }

  const sharedProperties = visualProperties.filter((property) => ![
    'backgroundColor',
    'backgroundImage',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'boxShadow',
    'backdropFilter',
  ].includes(property));

  for (const selector of selectors) {
    for (const property of sharedProperties) {
      assert.equal(
        measurements.mobile[selector][property],
        measurements.desktop[selector][property],
        `mobile ${selector} should keep desktop ${property}`,
      );
    }
  }

  const mobileBubble = measurements.mobile['.msg-user-bubble'];
  assert.notEqual(mobileBubble.backgroundColor, 'rgba(0, 0, 0, 0)', 'mobile bubble should retain a solid fill');
  assert.equal(mobileBubble.backgroundImage, 'none', 'mobile bubble should not use a gradient or sheen');
  assert.equal(mobileBubble.borderTopWidth, '0px', 'mobile bubble should not have a top border');
  assert.equal(mobileBubble.borderRightWidth, '0px', 'mobile bubble should not have a right border');
  assert.equal(mobileBubble.borderBottomWidth, '0px', 'mobile bubble should not have a bottom border');
  assert.equal(mobileBubble.borderLeftWidth, '0px', 'mobile bubble should not have a left border');
  assert.equal(mobileBubble.boxShadow, 'none', 'mobile bubble should not be elevated');
  assert.equal(mobileBubble.backdropFilter, 'none', 'mobile bubble should not blur the transcript');
} finally {
  await browser.close();
}

console.log('test-chat-message-bubble-responsive: ok');
