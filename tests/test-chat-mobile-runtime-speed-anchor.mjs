#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const [template, responsiveCss, iconsSource] = await Promise.all([
  readFile(join(repoRoot, 'templates', 'chat.html'), 'utf8'),
  readFile(join(repoRoot, 'static', 'chat', 'chat-responsive.css'), 'utf8'),
  readFile(join(repoRoot, 'static', 'chat', 'icons.js'), 'utf8'),
]);

const controlsStart = template.indexOf('id="composerRuntimeControls"');
const speedStart = template.indexOf('id="composerRuntimeSpeedBtn"');
const runtimeStart = template.indexOf('id="composerRuntimeBtn"');
const providerStart = template.indexOf('id="composerRuntimeProviderView"');
assert.ok(controlsStart >= 0, 'composer runtime controls should exist');
assert.ok(speedStart > controlsStart, 'speed button should be inside the main composer controls');
assert.ok(speedStart < runtimeStart, 'speed button should precede the main model/runtime button');
assert.ok(speedStart < providerStart, 'speed button should not be nested in the second-level runtime Provider view');
assert.match(
  template,
  /id="composerRuntimeSpeedIcon"[^>]*data-icon="gauge"/,
  'speed button should use the compact dynamic gauge icon',
);
assert.match(
  iconsSource,
  /gauge:.*class="gauge-needle"/,
  'gauge icon should expose a rotatable needle',
);
assert.match(
  iconsSource,
  /class="gauge-track"[^>]*stroke="currentColor"[^>]*stroke-opacity="0\.22"[^>]*d="M3\.43 17\.95A9\.9 9\.9 0 1 1 20\.57 17\.95"/,
  'gauge should use the Android 240-degree track geometry',
);
assert.match(
  iconsSource,
  /class="gauge-active"[^>]*stroke="#007AFF"[^>]*pathLength="1"[^>]*stroke-dasharray="0\.0125 1"[^>]*d="M3\.43 17\.95A9\.9 9\.9 0 1 1 20\.57 17\.95"/,
  'gauge should expose a blue active arc with a visible minimum sweep',
);
assert.match(
  iconsSource,
  /class="gauge-needle" fill="none" stroke="#1C1C1E"[^>]*d="M12 13V6\.27".*class="gauge-hub" cx="12" cy="13" r="2"/,
  'gauge needle and hub should share the Android center and dark neutral color',
);

assert.match(
  responsiveCss,
  /\.composer-runtime-controls\s*>\s*\.composer-runtime-speed-anchor\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center;/,
  'mobile speed anchor should align with the main composer runtime controls',
);
assert.match(
  responsiveCss,
  /@media \(min-width: 768px\)\s*\{[\s\S]*?\.composer-runtime-speed-btn:not\(\[hidden\]\)\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?width:\s*44px;[\s\S]*?min-height:\s*44px;/,
  'desktop should expose the speedometer button as a 44px control',
);
assert.match(
  responsiveCss,
  /@media \(min-width: 768px\)\s*\{[\s\S]*?\.composer-runtime-speed-panel:not\(\[hidden\]\)\s*\{[\s\S]*?display:\s*block;[\s\S]*?left:\s*50%;[\s\S]*?bottom:\s*calc\(100% \+ 10px\);[\s\S]*?width:\s*220px;/,
  'desktop speed panel should stay centered above its trigger',
);
assert.match(
  responsiveCss,
  /\.composer-runtime-speed-panel:not\(\[hidden\]\)\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?left:\s*50%;[\s\S]*?bottom:\s*calc\(100%\s*\+\s*8px\);/,
  'speed panel should rise from the main speed button',
);

const inputCss = await readFile(join(repoRoot, 'static', 'chat', 'chat-input.css'), 'utf8');
const toolingSource = readFileSync(join(repoRoot, 'static', 'chat', 'tooling.js'), 'utf8');
assert.match(
  inputCss,
  /\.composer-runtime-speed-panel\.composer-menu--portaled\s*\{[\s\S]*?position:\s*fixed\s*!important;[\s\S]*?z-index:\s*200;/,
  'speed panel should escape the composer clipping context when open',
);
assert.match(
  inputCss,
  /@keyframes composer-runtime-effort-pulse\s*\{[\s\S]*?background-position:\s*100%\s*0,[\s\S]*?background-position:\s*-100%\s*0,/,
  'effort pulse should travel from left to right',
);
assert.match(
  inputCss,
  /\.composer-runtime-effort-range\.is-dragging\s*\{/,
  'effort slider should expose a direct-manipulation state',
);
assert.match(
  responsiveCss,
  /\.composer-runtime-speed-select\s*\{[\s\S]*?min-height:\s*44px;[\s\S]*?border:\s*0\s*!important;/,
  'mobile speed selector should stay borderless and preserve the compact touch target',
);
assert.match(
  responsiveCss,
  /\.composer-runtime-speed-panel:not\(\.has-speed-choice\) \.composer-runtime-speed-select-wrap\s*\{[\s\S]*?display:\s*none;/,
  'speed panel should remove the unavailable service-tier control for compact height',
);
assert.match(
  readFileSync(join(repoRoot, 'static', 'chat', 'chat-m3-components.css'), 'utf8'),
  /\.composer-runtime-speed-select:focus-visible\s*\{[\s\S]*?outline:\s*none\s*!important;[\s\S]*?box-shadow:\s*none\s*!important;/,
  'speed selector should not restore a focus outline over the borderless capsule',
);
assert.match(
  inputCss,
  /\.composer-runtime-speed-icon \.gauge-needle\s*\{[\s\S]*?transform-origin:\s*12px 13px;/,
  'gauge needle animation should rotate around the Android gauge center',
);
assert.match(
  readFileSync(join(repoRoot, 'static', 'chat', 'chat-m3-components.css'), 'utf8'),
  /\.composer-runtime-speed-icon \.rl-icon\s*\{[\s\S]*?width:\s*24px;[\s\S]*?height:\s*24px;/,
  'web gauge should preserve Android 24dp visual size so the needle remains visible',
);
assert.match(
  inputCss,
  /\.composer-runtime-effort-slider\s*\{[\s\S]*?padding:\s*0;/,
  'effort capsule should not add extra vertical padding around the track',
);
assert.match(
  template,
  /id="composerRuntimeEffortRange"[^>]*type="range"[^>]*step="any"/,
  'effort slider should allow continuous pointer movement',
);
assert.match(
  toolingSource,
  /getComposerRuntimeEffortPointerValue[\s\S]*?setPointerCapture[\s\S]*?pointermove[\s\S]*?releasePointerCapture/,
  'effort slider should follow the pointer continuously while dragging',
);
assert.match(
  toolingSource,
  /function syncComposerRuntimeSpeedIcon[\s\S]*?needle\.style\.transform\s*=\s*`rotate\(\$\{angle\}deg\)`/,
  'gauge needle should follow the selected effort ratio',
);
assert.match(
  toolingSource,
  /const angle = 240 \+ \(normalizedRatio \* 240\);[\s\S]*?activeArc\.setAttribute\("stroke-dasharray", `\$\{activeSweep\} 1`\)/,
  'gauge arc and needle should use the Android 240-degree mapping',
);
assert.doesNotMatch(
  toolingSource,
  /composerRuntimeReasoningOptions|renderComposerRuntimeReasoningOptions|getComposerRuntimeReasoningOptions/,
  'the removed second-level reasoning list should not remain in the runtime picker',
);

console.log('test-chat-mobile-runtime-speed-anchor: ok');
