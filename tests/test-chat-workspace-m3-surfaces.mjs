#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../static/chat/chat-m3-components.css', import.meta.url), 'utf8');

assert.match(
  css,
  /\.workspace-file-reader,[\s\S]*?\.right-sidebar\s*\{[\s\S]*?background:\s*var\(--sys-surface\) !important;[\s\S]*?box-shadow:\s*none;/,
  'workspace reader and right sidebar should use stable M3 surfaces',
);

assert.match(
  css,
  /\.workspace-file-reader-search,[\s\S]*?\.workspace-readable-toolbar\s*\{[\s\S]*?background:\s*var\(--sys-surface-container-low\) !important;[\s\S]*?backdrop-filter:\s*none;/,
  'reader headers and toolbar should not depend on blur or gradients',
);

assert.match(
  css,
  /\.workspace-file-tree-folder-toggle:hover,[\s\S]*?\.workspace-file-tree-file\.active\s*\{[\s\S]*?background:\s*var\(--sys-primary-container\);[\s\S]*?color:\s*var\(--sys-on-primary-container\);/,
  'active workspace tree items should use the primary container role',
);

assert.match(
  css,
  /\.right-sidebar-big-button\s*\{[\s\S]*?border-radius:\s*var\(--m3-shape-large\);[\s\S]*?background:\s*var\(--sys-surface-container-high\) !important;[\s\S]*?box-shadow:\s*var\(--m3-elevation-1\);/,
  'right sidebar entry cards should use an M3 elevated container',
);

console.log('test-chat-workspace-m3-surfaces: ok');
