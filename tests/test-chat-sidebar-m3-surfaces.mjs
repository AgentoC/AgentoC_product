#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../static/chat/chat-m3-components.css', import.meta.url), 'utf8');

assert.match(
  css,
  /\.sidebar\s*\{[\s\S]*?background:\s*var\(--sys-surface-container-low\) !important;[\s\S]*?box-shadow:\s*none !important;/,
  'the persistent sidebar shell should use an opaque M3 surface',
);

assert.match(
  css,
  /\.sidebar-device-name-btn,[\s\S]*?\.sidebar-primary-action\s*\{[\s\S]*?background:\s*var\(--sys-surface-container\);[\s\S]*?box-shadow:\s*none !important;/,
  'sidebar controls should use M3 container surfaces without glass shadows',
);

assert.match(
  css,
  /\.session-item\.active\s*\{[\s\S]*?background:\s*var\(--sys-primary-container\) !important;[\s\S]*?-webkit-backdrop-filter:\s*none !important;[\s\S]*?backdrop-filter:\s*none !important;/,
  'the active session should use the M3 primary container and not depend on blur',
);

assert.match(
  css,
  /\.sidebar-bottom-frost\s*\{[\s\S]*?background:\s*var\(--sys-surface-container-low\) !important;[\s\S]*?backdrop-filter:\s*none !important;/,
  'the persistent bottom reserve should not be a blurred gradient surface',
);

assert.match(
  css,
  /\.settings-group-card,[\s\S]*?\.settings-connector-frame-wrap\s*\{[\s\S]*?background:\s*var\(--sys-surface-container\) !important;[\s\S]*?border-color:\s*var\(--sys-outline-variant\) !important;/,
  'settings groups should use M3 container and outline roles',
);

assert.match(
  css,
  /\.sidebar \.sidebar-new-chat-btn\s*\{[\s\S]*?background:\s*var\(--sys-primary\) !important;[\s\S]*?color:\s*var\(--sys-on-primary\) !important;/,
  'the primary new-chat action should use M3 primary roles',
);

console.log('test-chat-sidebar-m3-surfaces: ok');
