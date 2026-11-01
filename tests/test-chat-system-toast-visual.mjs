#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const repoRoot = new URL('..', import.meta.url);
const [initSource, m3Tokens, m3Components, materialFinish] = await Promise.all([
  readFile(new URL('../static/chat/init.js', import.meta.url), 'utf8'),
  readFile(new URL('../static/chat/chat-m3-tokens.css', import.meta.url), 'utf8'),
  readFile(new URL('../static/chat/chat-m3-components.css', import.meta.url), 'utf8'),
  readFile(new URL('../static/chat/chat-material-finish.css', import.meta.url), 'utf8'),
]);

assert.match(initSource, /document\.createElement\("button"\)/, 'system toast should use a semantic button for dismissal');
assert.match(initSource, /toast\.className = "system-toast"/, 'system toast should use the shared CSS surface');
assert.match(initSource, /system-toast__close/, 'system toast should expose a desktop close affordance');
assert.match(initSource, /pointermove/, 'system toast should track a direct-manipulation swipe');
assert.match(initSource, /is-leaving-right/, 'system toast should animate right-swipe dismissal');
assert.match(initSource, /__systemToastSuppressClick/, 'system toast swipe should not fall through to a click dismissal');
assert.doesNotMatch(initSource, /bgColor|background:\$\{bgColor\}/, 'system toast should not carry legacy hardcoded color styles');
assert.match(materialFinish, /\.system-toast\s*\{[\s\S]*?min-height:\s*48px !important;[\s\S]*?border-radius:\s*9999px !important/, 'system toast should use the shared capsule surface');
assert.match(materialFinish, /\.system-toast\[data-level="error"\]\s*\{[\s\S]*?background:/, 'error toast should use a restrained semantic surface');
assert.doesNotMatch(materialFinish, /\.system-toast\[data-level="error"\]\s*\{[\s\S]*?background:\s*var\(--sys-error-container\)/, 'error toast should not become a full red banner');
assert.match(materialFinish, /\.system-toast,[\s\S]*?\.oneui-notification__answer-deny\s*\{[\s\S]*?-webkit-appearance:\s*none !important;[\s\S]*?appearance:\s*none !important;/, 'notification controls should use the shared CSS appearance on every platform');
assert.match(m3Components, /\.system-toast\.is-leaving-right/, 'system toast has a right-swipe exit state');
assert.match(m3Components, /@media \(min-width: 768px\)[\s\S]*?\.system-toast__close/, 'system toast close affordance is desktop-only');
assert.doesNotMatch(
  materialFinish,
  /:root:not\(\[data-theme="light"\]\)\s+(?:\.system-toast|#attentionPopupHost \.oneui-notification)/,
  'notification surfaces must not treat every non-explicit-light theme as dark',
);

const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [{ name: 'mobile', width: 390, height: 844 }, { name: 'desktop', width: 1024, height: 768 }]) {
    const page = await browser.newPage({ viewport });
    await page.setContent(`<!doctype html><html data-theme="light"><head><style>${m3Tokens}\n${m3Components}\n${materialFinish}\nhtml,body{margin:0;min-height:100%;background:var(--sys-surface);font-family:system-ui,sans-serif;}</style></head><body><div id="system-toast-container" class="system-toast-container" role="status" aria-live="polite"><button type="button" class="system-toast is-visible" data-level="error" aria-label="Could not send the decision"><span class="system-toast__message">Could not send the decision</span><span class="system-toast__close" aria-hidden="true"><span class="system-toast__close-icon">×</span></span></button></div></body></html>`);
    const metrics = await page.locator('.system-toast').evaluate((node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      radius: style.borderTopLeftRadius,
      background: style.backgroundColor,
      color: style.color,
      shadow: style.boxShadow,
      appearance: style.appearance,
      overflow: node.scrollWidth > node.clientWidth,
      closeVisible: getComputedStyle(node.querySelector('.system-toast__close')).display !== 'none',
    };
    });
    if (viewport.name === 'mobile') {
      assert.equal(metrics.width, 370, 'mobile toast should keep 10px side margins');
    } else {
      assert.equal(metrics.width, 520, 'desktop toast should keep the shared notification rail width');
    }
    assert.ok(metrics.height >= 48, `${viewport.name} toast should keep a readable touch surface`);
    assert.notEqual(metrics.radius, '0px', `${viewport.name} toast should use the shared control radius`);
    assert.notEqual(metrics.background, 'rgb(255, 218, 214)', `${viewport.name} error toast should not use the full M3 error container`);
    assert.notEqual(metrics.color, 'rgb(65, 0, 2)', `${viewport.name} error toast text should stay in the workbench hierarchy`);
    assert.equal(metrics.appearance, 'none', `${viewport.name} toast should not use native button painting`);
    assert.equal(metrics.overflow, false, `${viewport.name} toast text should stay inside the viewport`);
    assert.notEqual(metrics.shadow, 'none', `${viewport.name} toast should remain visually separated from the canvas`);
    assert.equal(metrics.closeVisible, viewport.name === 'desktop', `${viewport.name} close affordance follows the platform breakpoint`);
    await page.close();
  }

  for (const scenario of [
    { label: 'system-light', theme: '', colorScheme: 'light', light: true },
    { label: 'system-dark', theme: '', colorScheme: 'dark', light: false },
    { label: 'blue-light', theme: 'blue', colorScheme: 'light', light: true },
  ]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: scenario.colorScheme });
    const themeAttr = scenario.theme ? ` data-theme="${scenario.theme}"` : '';
    await page.setContent(`<!doctype html><html${themeAttr}><head><style>${m3Tokens}\n${m3Components}\n${materialFinish}\nhtml,body{margin:0;min-height:100%;background:var(--sys-surface);font-family:system-ui,sans-serif;}</style></head><body><button class="system-toast is-visible">通知内容</button><div id="attentionPopupHost"><div class="oneui-notification"><div class="oneui-notification__title">注意力通知</div></div></div></body></html>`);
    const colors = await page.evaluate(() => {
      const toast = getComputedStyle(document.querySelector('.system-toast'));
      const attention = getComputedStyle(document.querySelector('#attentionPopupHost .oneui-notification'));
      return {
        toastBackground: toast.backgroundColor,
        attentionBackground: attention.backgroundColor,
        toastColor: toast.color,
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
      };
    });
    assert.equal(colors.toastBackground, colors.attentionBackground, `${scenario.label}: toast and attention surfaces share one theme-aware background`);
    if (scenario.light) {
      assert.notEqual(colors.toastBackground, 'rgb(30, 30, 36)', `${scenario.label}: toast must not use the dark surface`);
      assert.notEqual(colors.attentionBackground, 'rgb(24, 24, 27)', `${scenario.label}: attention notification must not use the dark surface`);
      assert.notEqual(colors.toastColor, 'rgb(255, 255, 255)', `${scenario.label}: text must remain readable on the light surface`);
      assert.equal(colors.colorScheme, 'light', `${scenario.label}: browser and tokens agree on a light scheme`);
    } else {
      assert.equal(colors.colorScheme, 'dark', `${scenario.label}: browser and tokens agree on a dark scheme`);
      assert.notEqual(colors.toastBackground, 'rgb(238, 241, 244)', `${scenario.label}: toast must not use the light surface`);
    }
    await page.close();
  }

  const swipePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await swipePage.setContent(`<!doctype html><html data-theme="light"><head><style>${m3Tokens}\n${m3Components}\n${materialFinish}\nhtml,body{margin:0;min-height:100%;background:var(--sys-surface);font-family:system-ui,sans-serif;}</style></head><body></body></html>`);
  const toastFunction = initSource.slice(
    initSource.indexOf('function showSystemToast'),
    initSource.indexOf('// ---- Visitor mode setup'),
  );
  await swipePage.addScriptTag({ content: `${toastFunction}\nwindow.__showSystemToast = showSystemToast;` });
  await swipePage.evaluate(() => window.__showSystemToast('Swipe me away', 'info'));
  const swipeToast = swipePage.locator('.system-toast');
  await swipeToast.waitFor();
  await swipePage.waitForTimeout(40);
  const swipeBox = await swipeToast.boundingBox();
  assert.ok(swipeBox, 'mobile toast should expose gesture geometry');
  await swipePage.mouse.move(swipeBox.x + 12, swipeBox.y + swipeBox.height / 2);
  await swipePage.mouse.down();
  await swipePage.mouse.move(swipeBox.x + swipeBox.width * 0.55, swipeBox.y + swipeBox.height / 2, { steps: 5 });
  await swipePage.mouse.up();
  await swipePage.waitForTimeout(300);
  assert.equal(await swipePage.locator('.system-toast').count(), 0, 'a right swipe dismisses a live system toast');

  await swipePage.evaluate(() => window.__showSystemToast('Interrupt the rebound', 'info'));
  const interruptedToast = swipePage.locator('.system-toast');
  await interruptedToast.waitFor();
  await swipePage.waitForTimeout(40);
  const interruptedBox = await interruptedToast.boundingBox();
  assert.ok(interruptedBox, 'toast should remain available for an interruption test');
  await swipePage.mouse.move(interruptedBox.x + 12, interruptedBox.y + interruptedBox.height / 2);
  await swipePage.mouse.down();
  await swipePage.mouse.move(interruptedBox.x + 42, interruptedBox.y + interruptedBox.height / 2, { steps: 3 });
  await swipePage.mouse.up();
  await swipePage.waitForTimeout(20);
  const reboundBox = await interruptedToast.boundingBox();
  assert.ok(reboundBox, 'toast should remain mounted during snap-back');
  await swipePage.mouse.move(reboundBox.x + 12, reboundBox.y + reboundBox.height / 2);
  await swipePage.mouse.down();
  await swipePage.mouse.move(reboundBox.x + 82, reboundBox.y + reboundBox.height / 2, { steps: 3 });
  await swipePage.waitForTimeout(300);
  assert.match(await interruptedToast.evaluate((node) => node.style.transform), /70px/, 'a new toast gesture survives the previous snap-back cleanup');
  await swipePage.mouse.up();
  await swipePage.close();
} finally {
  await browser.close();
}

console.log('test-chat-system-toast-visual: ok');
