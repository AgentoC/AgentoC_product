#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const template = readFileSync(join(repoRoot, 'templates', 'chat.html'), 'utf8');
const inputCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-input.css'), 'utf8');
const liveStatusCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-live-status.css'), 'utf8');
const messageCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-messages.css'), 'utf8');
const workbenchCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-workbench.css'), 'utf8');
const responsiveCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-responsive.css'), 'utf8');
const i18nSource = readFileSync(join(repoRoot, 'static', 'chat', 'i18n.js'), 'utf8');

assert.match(template, /id="liveBar"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/);
assert.doesNotMatch(template, /id="runActivityStrip"/);
assert.doesNotMatch(inputCss, /run-activity-strip/);
assert.doesNotMatch(liveStatusCss, /\.live-bar\[data-state="running"\] \.live-bar__label::after[\s\S]*content: attr\(data-shimmer-text\)[\s\S]*animation: live-bar-text-shimmer/);
assert.doesNotMatch(liveStatusCss, /@keyframes live-bar-text-shimmer/);
assert.doesNotMatch(messageCss, /\.thinking-block[\s\S]*?thinking-sweep|\.thinking-block[\s\S]*?background-clip:\s*text/, 'expanded thinking blocks should stay calm and readable');
assert.match(messageCss, /@keyframes mobile-live-dots-rotate[\s\S]*rotate\(360deg\)/);
assert.match(messageCss, /@keyframes mobile-live-dot-sequence-[abc]/);
assert.match(messageCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.mobile-live-activity-line__dots[\s\S]*?animation: none !important/);
assert.match(messageCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.mobile-live-activity-line__dot[\s\S]*?animation: none !important/);
assert.doesNotMatch(messageCss, /mobile-live-execution-travel|mobile-live-execution-breathe/);
assert.match(messageCss, /\.thinking-block\.running \.thinking-icon\s*\{[\s\S]*?animation:\s*thinking-breathe 1\.8s ease-in-out infinite/);
assert.doesNotMatch(workbenchCss, /\.workbench-inspector\s*\{[\s\S]*?will-change:\s*transform, opacity;/, 'Workbench should not reserve compositor memory while idle');
assert.match(liveStatusCss, /\.live-bar\[data-state="running"\] \.live-bar__orb-sphere[\s\S]*animation: live-bar-orb-breathe 2\.6s var\(--motion-ease-standard, ease-in-out\) infinite/);
assert.match(liveStatusCss, /\.live-bar-slot\.is-collapsing \.live-bar[\s\S]*animation: live-bar-collapse-to-composer 280ms cubic-bezier\(0\.4, 0, 0\.2, 1\)/);
assert.match(liveStatusCss, /@keyframes live-bar-collapse-to-composer[\s\S]*translateY\(14px\) scale\(0\.96\)/);
assert.match(liveStatusCss, /\.live-bar-slot\.is-revealing \.live-bar[\s\S]*animation: live-bar-reveal-from-composer 280ms cubic-bezier\(0\.16, 1, 0\.3, 1\)/);
assert.match(liveStatusCss, /\.live-bar\s*\{[\s\S]*?width 320ms[\s\S]*?height 320ms[\s\S]*?border-radius 320ms/);
assert.match(liveStatusCss, /\.live-bar\s*\{[\s\S]*border:\s*0;[\s\S]*box-shadow:/);
assert.match(liveStatusCss, /\.live-bar\s*\{[\s\S]*?box-shadow:\s*var\(--shadow-soft,[\s\S]*?\}/, 'Live Bar should use a themed soft shadow instead of a white top highlight');
assert.doesNotMatch(liveStatusCss, /\.live-bar\s*\{[\s\S]*?inset 0 1px 0 color-mix\(in srgb, #ffffff/, 'Live Bar should not draw a visible white top line in dark mode');
assert.doesNotMatch(liveStatusCss, /\.live-bar\[data-state="running"\]\s*\{[\s\S]*?inset 0 1px 0 color-mix\(in srgb, #ffffff/, 'running Live Bar should not reintroduce a white top highlight');
assert.match(inputCss, /\.queued-steer-row\s*\{[\s\S]*?background:\s*var\(--surface-soft, var\(--bg-secondary\)\);[\s\S]*?box-shadow:\s*var\(--shadow-soft,/, 'queued steer rows should use a neutral soft surface instead of a strong queued-color fill');
assert.doesNotMatch(inputCss, /\.queued-steer-row\s*\{[\s\S]*?background:\s*var\(--status-queued-bg/, 'queued steer rows should not render as green queued-color cards');
assert.doesNotMatch(inputCss, /\.queued-steer-row(?:--waiting)?\s*\{[\s\S]*?inset 0 1px 0 color-mix\(in srgb, #ffffff/, 'queued steer rows should not draw a visible white top line in dark mode');
assert.match(liveStatusCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.live-bar\[data-state="running"\] \.live-bar__orb-sphere\s*\{\s*animation: none/);
assert.doesNotMatch(liveStatusCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.live-bar\[data-state="running"\] \.live-bar__label::after/);
assert.match(messageCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.live-operation-row\.state-running \.live-operation-row__mark::after[\s\S]*animation: none !important/);
assert.match(messageCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.mobile-live-activity-line__dots[\s\S]*animation: none !important/);

assert.doesNotMatch(responsiveCss, /run-activity-strip/);
assert.match(messageCss, /\.live-operation-row__detail[\s\S]*overflow: hidden;[\s\S]*text-overflow: ellipsis/);
assert.match(messageCss, /\.live-operation-row__output[\s\S]*max-height: 152px;[\s\S]*overflow-x: hidden;[\s\S]*overflow-y: auto/);

assert.match(i18nSource, /"activity\.label\.command": "Running command"/);
assert.match(i18nSource, /"activity\.label\.command": "正在执行命令"/);
assert.match(i18nSource, /"operation\.state\.waiting_approval": "Waiting for approval"/);
assert.match(i18nSource, /"operation\.state\.waiting_approval": "等待审批"/);
assert.match(i18nSource, /"operation\.output\.omitted": "已省略 \{count\} 行输出"/);

console.log('test-chat-operation-reduced-motion: ok');
