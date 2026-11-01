#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const [baseCss, inputCss, responsiveCss, glassCss] = await Promise.all([
  'static/chat/chat-base.css',
  'static/chat/chat-input.css',
  'static/chat/chat-responsive.css',
  'static/chat/chat-glass.css',
].map((file) => readFile(join(repoRoot, file), 'utf8')));

assert.match(glassCss, /--composer-glass-fill:[\s\S]*?76%, transparent/, 'mobile composer needs a translucent glass fill');
assert.match(glassCss, /\.input-wrapper::before[\s\S]*?linear-gradient\(112deg/, 'mobile composer needs a restrained top-edge highlight');
assert.match(glassCss, /\.input-wrapper \{[\s\S]*?backdrop-filter: blur\(22px\) saturate\(1\.16\)/, 'mobile composer needs the reference-like glass blur');
assert.match(glassCss, /\.input-actions-row \{ padding: 3px 8px 7px; background: transparent; box-shadow: none; \}/, 'composer actions must live inside the same glass object');
assert.match(glassCss, /@media \(max-width: 767px\) \{[\s\S]*?\.input-wrapper \{[\s\S]*?linear-gradient\(112deg, rgba\(255, 255, 255, 0\.54\)/, 'mobile composer needs a visible fill highlight on a light canvas');
assert.match(glassCss, /\.input-wrapper\.is-edit-resend\s*\{\s*overflow:\s*visible;\s*\}/, 'edit-resend must keep the composer material while allowing the close control to escape');
assert.doesNotMatch(glassCss, /\.input-wrapper\.is-edit-resend[\s\S]*?background:\s*transparent/, 'edit-resend must not make the composer transparent');
assert.match(responsiveCss, /--mx-r-control: 14px;[\s\S]*?--mx-r-row: 16px;[\s\S]*?--mx-r-card: 20px;/, 'mobile surfaces need a compact corner hierarchy');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  await page.setContent(`<!doctype html><style>${baseCss}\n${inputCss}\n${responsiveCss}\n${glassCss}</style><style>html,body{height:100%;margin:0}.input-area{position:absolute;left:0;right:0;bottom:0}.input-wrapper{margin:10px}.input-row{position:relative}.input-actions-row{display:flex}.send-btn{width:44px;height:44px;border-radius:50%;background:#202124}.composer-runtime-btn,.composer-action-btn{width:44px;height:44px}.input-actions-group.right{margin-left:auto}</style><div class="input-area"><div class="input-wrapper"><div class="input-row"><textarea placeholder="Message"></textarea></div><div class="input-actions-row"><button class="composer-action-btn">+</button><div class="input-actions-group right"><button class="composer-runtime-btn">default</button><button class="send-btn">Send</button></div></div></div></div>`);
  const metrics = await page.evaluate(() => {
    const read = (selector) => getComputedStyle(document.querySelector(selector));
    const composer = read('.input-wrapper');
    const actions = read('.input-actions-row');
    const runtime = read('.composer-runtime-btn');
    return {
      radius: composer.borderTopLeftRadius,
      border: composer.borderTopColor,
      blur: composer.backdropFilter || composer.webkitBackdropFilter,
      shadow: composer.boxShadow,
      actionBackground: actions.backgroundColor,
      actionShadow: actions.boxShadow,
      runtimeShadow: runtime.boxShadow,
    };
  });
  assert.equal(metrics.radius, '20px');
  assert.match(metrics.blur, /blur\(22px\)/);
  assert.notEqual(metrics.shadow, 'none');
  assert.equal(metrics.actionShadow, 'none');
  assert.equal(metrics.runtimeShadow, 'none');

  const editMetrics = await page.evaluate(() => {
    const wrapper = document.querySelector('.input-wrapper');
    wrapper.classList.add('is-edit-resend');
    const style = getComputedStyle(wrapper);
    return {
      background: style.backgroundImage,
      border: style.borderTopColor,
      blur: style.backdropFilter || style.webkitBackdropFilter,
      shadow: style.boxShadow,
      overflow: style.overflow,
    };
  });
  assert.notEqual(editMetrics.background, 'none', 'edit-resend should retain the composer background');
  assert.match(editMetrics.blur, /blur\(22px\)/, 'edit-resend should retain the composer glass blur');
  assert.notEqual(editMetrics.shadow, 'none', 'edit-resend should retain the composer shadow');
  assert.equal(editMetrics.overflow, 'visible', 'edit-resend should let the close control escape above the composer');
  await page.close();
  console.log('test-chat-composer-glass-material: ok');
} finally {
  await browser.close();
}
