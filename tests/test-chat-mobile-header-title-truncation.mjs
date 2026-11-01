#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const baseCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-base.css'), 'utf8');
const responsiveCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-responsive.css'), 'utf8');
const template = readFileSync(join(repoRoot, 'templates', 'chat.html'), 'utf8');

assert.match(
  baseCss,
  /\.header\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*\}/s,
  'header container should clip overflow so long titles cannot widen the mobile shell',
);

assert.match(
  baseCss,
  /\.header h1\s*\{[^}]*display:\s*block;[^}]*flex:\s*1;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*white-space:\s*nowrap;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*\}/s,
  'header title should stay on one line and truncate with ellipsis when space is limited',
);

assert.match(
  responsiveCss,
  /@media \(max-width: 767px\)[\s\S]*--app-header-height:\s*52px;/,
  'mobile App Bar should always use the compact height',
);
assert.doesNotMatch(responsiveCss, /app-bar-expanded|app-bar-collapsed/);
assert.doesNotMatch(template, /id="headerSubtitle"|header-subtitle-status\.js|app-bar-collapse\.js/);

console.log('test-chat-mobile-header-title-truncation: ok');
