#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../static/chat/chat-m3-components.css', import.meta.url), 'utf8');

assert.match(
  css,
  /\.msg-user-bubble\s*\{[\s\S]*?background:\s*var\(--message-bubble-fill,\s*var\(--sys-primary-container\)\);[\s\S]*?color:\s*var\(--message-bubble-on,\s*var\(--sys-on-primary-container\)\);[\s\S]*?backdrop-filter:\s*none;/,
  'user message bubbles should use a dedicated quiet surface without blur',
);

assert.match(
  css,
  /\.msg-touch-menu\s*\{[\s\S]*?border-radius:\s*var\(--m3-shape-extra-large\) !important;[\s\S]*?background:\s*var\(--sys-surface-container-high\);[\s\S]*?box-shadow:\s*var\(--m3-elevation-3\);/,
  'the portaled message menu should use an M3 elevated surface',
);

assert.match(
  css,
  /\.md-content pre,[\s\S]*?\.diff-block\s*\{[\s\S]*?background:\s*var\(--sys-surface-container-high\) !important;[\s\S]*?border-radius:\s*var\(--m3-shape-medium\);[\s\S]*?overflow:\s*hidden;/,
  'code, diagrams, tools, and diffs should share an M3 container shape',
);

assert.match(
  css,
  /\.change-type\.add,[\s\S]*?\.diff-line-add\s*\{[\s\S]*?background:\s*var\(--sys-success-container\);[\s\S]*?color:\s*var\(--sys-on-success-container\);/,
  'added diff lines should use the shared M3 success container role',
);

assert.match(
  css,
  /\.change-type\.delete,[\s\S]*?\.diff-line-remove\s*\{[\s\S]*?background:\s*var\(--sys-error-container\);[\s\S]*?color:\s*var\(--sys-on-error-container\);/,
  'removed diff lines should use the M3 error container role',
);

console.log('test-chat-messages-m3-surfaces: ok');
