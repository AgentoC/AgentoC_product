#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [css, liveStatusCss] = await Promise.all([
  readFile(new URL('../static/chat/chat-m3-components.css', import.meta.url), 'utf8'),
  readFile(new URL('../static/chat/chat-live-status.css', import.meta.url), 'utf8'),
]);

assert.match(
  css,
  /Live Bar remains on the versioned online\/deb surface contract\.[\s\S]*?not mapped to the shared M3 color roles/,
  'Live Bar should remain outside the shared M3 color layer',
);

assert.match(
  liveStatusCss,
  /\.live-bar\s*\{[\s\S]*?border-radius:\s*var\(--radius-pill,\s*999px\);[\s\S]*?background:\s*color-mix\(in srgb, var\(--bg-secondary\) 92%, var\(--bg-tertiary\)\);[\s\S]*?box-shadow:\s*var\(--shadow-soft,/,
  'Live Bar should retain the versioned online capsule surface',
);

assert.match(
  css,
  /\.run-sheet\s*\{[\s\S]*?background:\s*var\(--sys-surface-container\) !important;[\s\S]*?box-shadow:\s*var\(--m3-elevation-3\) !important;[\s\S]*?backdrop-filter:\s*none !important;/,
  'Run Sheet should be an opaque M3 sheet instead of a blurred glass surface',
);

assert.match(
  css,
  /\.run-sheet__now,[\s\S]*?\.run-sheet__file\s*\{[\s\S]*?background:\s*transparent !important;[\s\S]*?box-shadow:\s*none !important;/,
  'Run Sheet content rows should inherit the sheet surface instead of becoming extra rectangular cards',
);

assert.match(
  css,
  /\.run-sheet__md-button\s*\{[\s\S]*?background:\s*var\(--sys-surface-container-high\) !important;[\s\S]*?box-shadow:\s*none !important;/,
  'Run Sheet Markdown artifact buttons should retain their rounded interactive surface',
);

console.log('test-chat-live-run-m3-surfaces: ok');
