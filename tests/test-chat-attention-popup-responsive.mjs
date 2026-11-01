#!/usr/bin/env node
// The mobile attention popup should keep the desktop material and effect
// contract. Only the viewport rail may constrain its available width.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-attention-popup.css',
  'static/chat/chat-m3-tokens.css',
  'static/chat/chat-m3-components.css',
  'static/chat/chat-material-finish.css',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');

const selectors = [
  '#attentionPopupHost',
  '.oneui-notification',
  '.oneui-notification__header',
  '.oneui-notification__title',
  '.oneui-notification__content',
  '.oneui-notification__footer',
];
const visualProperties = [
  'insetBlockStart',
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
  'color',
  'boxShadow',
  'backdropFilter',
  'fontSize',
  'lineHeight',
  'transitionProperty',
  'transitionDuration',
  'transitionTimingFunction',
];

const html = `<!doctype html>
<html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head>
<body><div id="attentionPopupHost"><article class="oneui-notification" role="status">
  <header class="oneui-notification__header"><div class="oneui-notification__title">整理本月报表并写入归档目录。</div></header>
  <div class="oneui-notification__content"></div>
  <footer class="oneui-notification__footer"></footer>
</article></div></body></html>`;

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

  for (const selector of selectors) {
    assert.deepEqual(
      measurements.mobile[selector],
      measurements.desktop[selector],
      `mobile ${selector} should keep the desktop notification material and effects`,
    );
  }
} finally {
  await browser.close();
}

console.log('test-chat-attention-popup-responsive: ok');
