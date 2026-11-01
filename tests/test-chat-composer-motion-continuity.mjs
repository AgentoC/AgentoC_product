#!/usr/bin/env node
// Regression gate for the Web composer's compact <-> expanded motion.
//
// It runs the exact production animation helpers in Chromium against the
// shipped CSS and samples every presented animation frame. The old rAF version
// could look mathematically continuous while separately rewriting the shell,
// rail, editor padding and editor cap; this test guards the actual visual
// geometry instead: one monotonic shell path, a fixed bottom rail, and no
// endpoint jump after the animation releases its inline styles.
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const composeSource = readFileSync(join(repoRoot, 'static/chat/compose.js'), 'utf8');
const inputCss = readFileSync(join(repoRoot, 'static/chat/chat-input.css'), 'utf8');
const styles = [
  'static/chat/chat-base.css',
  'static/chat/chat-input.css',
  'static/chat/chat.css',
  'static/chat/chat-responsive.css',
  'static/chat/chat-glass.css',
  'static/chat/chat-m3-tokens.css',
  'static/chat/chat-m3-components.css',
  'static/chat/chat-material-finish.css',
].map((path) => readFileSync(join(repoRoot, path), 'utf8')).join('\n');

assert.match(composeSource, /function createComposerSpringKeyframes[\s\S]*?wrapper\.animate\(/, 'the composer motion must be driven by one native Web Animations timeline');
assert.doesNotMatch(composeSource, /actionRow\.style\.|inputRow\.style\.padding|markdownEditor\.style\.maxHeight|requestAnimationFrame\(tick\)/, 'the motion path must not reflow children from JS every frame');
assert.match(inputCss, /\.input-actions-row\s*\{[^}]*height:\s*var\(--composer-actions-height\);[^}]*padding:\s*2px 0 2px 10px;/, 'the action rail must have one fixed geometry in both composer states');

const motionStart = composeSource.indexOf('function readComposerShellMotionSnapshot(');
const motionEnd = composeSource.indexOf('// The composer has one interaction surface', motionStart);
assert.ok(motionStart >= 0 && motionEnd > motionStart, 'could not extract the production composer motion helpers');
const motionHelpers = composeSource.slice(motionStart, motionEnd);

function fixtureHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${styles}</style>
<style>
  * { box-sizing: border-box; }
  html, body { min-height: 100%; margin: 0; }
  body { background: var(--chat-area-bg, #fafafa); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  .visual-chat { display: grid; grid-template-rows: minmax(0, 1fr) auto; min-height: 720px; }
  .messages { min-height: 450px; }
  .input-area { margin-right: 0; }
</style></head>
<body>
  <main class="visual-chat">
    <div class="messages"></div>
    <div class="input-area composer-expanded" id="inputArea">
      <div class="input-stack">
        <div class="input-wrapper">
          <div class="input-row"><div class="composer-markdown-editor" contenteditable="true" role="textbox" data-placeholder="输入消息..."></div></div>
          <div class="input-actions-row">
            <div class="input-actions-group input-actions-group--add"><button class="composer-action-btn composer-action-btn--upload" type="button" aria-label="Add">+</button></div>
            <div class="input-actions-group right"><div class="composer-runtime-controls" hidden></div><div class="send-stop-slot"><button class="send-btn" type="button" aria-label="Send">↑</button></div></div>
          </div>
        </div>
      </div>
    </div>
  </main>
  <script>
    const inputArea = document.getElementById('inputArea');
    let composerSizeAnimationCleanup = null;
    ${motionHelpers}

    function sampleComposer(time) {
      const wrapper = inputArea.querySelector('.input-wrapper');
      const action = inputArea.querySelector('.input-actions-row');
      const shell = wrapper.getBoundingClientRect();
      const rail = action.getBoundingClientRect();
      return {
        time,
        animating: wrapper.classList.contains('composer-size-animating'),
        height: shell.height,
        width: shell.width,
        left: shell.left,
        bottom: shell.bottom,
        radius: Number.parseFloat(getComputedStyle(wrapper).borderTopLeftRadius),
        actionHeight: rail.height,
        actionBottom: rail.bottom,
      };
    }

    window.__runComposerMotion = (direction) => new Promise((resolve) => {
      const wrapper = inputArea.querySelector('.input-wrapper');
      const start = readComposerShellMotionSnapshot(wrapper);
      inputArea.classList.toggle('composer-expanded', direction === 'expand');
      inputArea.classList.toggle('composer-collapsed', direction === 'collapse');
      animateComposerSize(start);
      const samples = [];
      let firstTime = null;
      let settledFrames = 0;
      const tick = (time) => {
        if (firstTime == null) firstTime = time;
        samples.push(sampleComposer(time - firstTime));
        const animating = samples.at(-1).animating;
        settledFrames = animating ? 0 : settledFrames + 1;
        if (settledFrames >= 3) {
          resolve(samples);
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  </script>
</body></html>`;
}

function assertContinuous(samples, direction) {
  assert.ok(samples.length >= 12, `${direction}: should paint a full motion sequence, got ${samples.length} frames`);
  const active = samples.filter((sample) => sample.animating);
  assert.ok(active.length >= 10, `${direction}: native timeline did not remain active long enough to inspect`);

  const sign = direction.includes('collapse') ? -1 : 1;
  const heightDelta = Math.abs(active.at(-1).height - active[0].height);
  const widthDelta = Math.abs(active.at(-1).width - active[0].width);
  assert.ok(heightDelta >= 20, `${direction}: shell must visibly change height, got ${heightDelta.toFixed(2)}px`);
  assert.ok(widthDelta >= 16, `${direction}: shell must visibly animate its horizontal inset, got ${widthDelta.toFixed(2)}px`);

  for (let index = 1; index < active.length; index += 1) {
    const previous = active[index - 1];
    const current = active[index];
    const heightStep = sign * (current.height - previous.height);
    const widthStep = sign * (current.width - previous.width);
    // The damped curve may settle below a device pixel at the end but must
    // never reverse or jump through an intermediate state.
    assert.ok(heightStep >= -0.35, `${direction}: shell height reversed at frame ${index}`);
    assert.ok(widthStep >= -0.35, `${direction}: shell width reversed at frame ${index}`);
    assert.ok(Math.abs(current.actionHeight - active[0].actionHeight) <= 0.25, `${direction}: fixed action rail changed height at frame ${index}`);
    // Desktop retains a transparent 1px shell border, so the rail is pinned
    // to the inner bottom edge rather than the outer border box.
    assert.ok(Math.abs(current.actionBottom - current.bottom) <= 1.5, `${direction}: action rail drifted from the bottom anchor at frame ${index}`);
  }

  const first = active[0];
  const final = samples.at(-1);
  assert.ok(Math.abs(final.height - active.at(-1).height) <= 0.5, `${direction}: clearing animation styles caused a height endpoint jump (${active.at(-1).height.toFixed(2)}px -> ${final.height.toFixed(2)}px)`);
  assert.ok(Math.abs(final.width - active.at(-1).width) <= 0.5, `${direction}: clearing animation styles caused a width endpoint jump (${active.at(-1).width.toFixed(2)}px -> ${final.width.toFixed(2)}px)`);
  assert.ok(Math.abs(final.radius - active.at(-1).radius) <= 0.5, `${direction}: clearing animation styles caused a corner-radius endpoint jump (${active.at(-1).radius.toFixed(2)}px -> ${final.radius.toFixed(2)}px)`);
  assert.ok(Math.abs(final.left - active.at(-1).left) <= 0.5, `${direction}: clearing animation styles caused a horizontal endpoint jump (${active.at(-1).left.toFixed(2)}px -> ${final.left.toFixed(2)}px)`);
  assert.notEqual(first.height, final.height, `${direction}: no-op motion is not a valid collapse/expand transition`);
}

const browser = await chromium.launch({ headless: true });
try {
  const scenarios = [
    { name: 'phone', viewport: { width: 390, height: 844 } },
    { name: 'desktop', viewport: { width: 1024, height: 768 } },
  ];
  const summaries = [];
  for (const scenario of scenarios) {
    const page = await browser.newPage({ viewport: scenario.viewport, colorScheme: 'light' });
    await page.setContent(fixtureHtml(), { waitUntil: 'load' });
    await page.waitForTimeout(80);
    const collapse = await page.evaluate(() => window.__runComposerMotion('collapse'));
    const expand = await page.evaluate(() => window.__runComposerMotion('expand'));
    assertContinuous(collapse, `${scenario.name} collapse`);
    assertContinuous(expand, `${scenario.name} expand`);
    summaries.push(`${scenario.name}: ${collapse.length}/${expand.length} frames`);
    await page.close();
  }
  console.log(`composer motion continuity: ok (${summaries.join(', ')})`);
} finally {
  await browser.close();
}
