#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const baseCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-base.css'), 'utf8');
const responsiveCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-responsive.css'), 'utf8');
const rightSidebarCss = readFileSync(join(repoRoot, 'static', 'chat', 'right-sidebar.css'), 'utf8');
const glassCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-glass.css'), 'utf8');

assert.match(
  baseCss,
  /\.header-overflow-menu\s*\{[\s\S]*?width:\s*min\(272px, calc\(100vw - 20px\)\);[\s\S]*?border-radius:\s*20px;[\s\S]*?background:\s*var\(--sidebar-glass-fallback/,
  'header overflow menu should use the shared frosted sidebar material instead of the old hard card',
);

assert.match(
  baseCss,
  /\.header-overflow-menu-item\s*\{[\s\S]*?min-height:\s*48px;[\s\S]*?border-radius:\s*14px;[\s\S]*?background:\s*transparent;/,
  'header overflow actions should be full-width touch rows rather than nested bordered cards',
);

assert.match(
  responsiveCss,
  /@media \(max-width: 767px\)[\s\S]*?\.header-more-btn:not\(\[hidden\]\)\s*\{[\s\S]*?width:\s*40px;[\s\S]*?height:\s*40px;[\s\S]*?background:\s*var\(--sidebar-glass-fallback/,
  'mobile header more button should match the glass header controls',
);

assert.match(
  responsiveCss,
  /@media \(max-width: 767px\)[\s\S]*?\.header-overflow-menu\s*\{[\s\S]*?top:\s*calc\(var\(--safe-top\) \+ 50px\);[\s\S]*?width:\s*min\(286px, calc\(100vw - 16px\)\);[\s\S]*?border-radius:\s*22px;/,
  'mobile overflow menu should sit below the header with phone-sized width and softer radius',
);

assert.match(
  rightSidebarCss,
  /@media \(max-width: 767px\)[\s\S]*?\.right-sidebar\s*\{[\s\S]*?left:\s*0;[\s\S]*?width:\s*100%;[\s\S]*?background:\s*var\(--chat-area-bg/,
  'mobile right sidebar should behave as a full-height app surface, not a narrow desktop drawer',
);

assert.match(
  rightSidebarCss,
  /@media \(max-width: 767px\)[\s\S]*?\.right-sidebar-header\s*\{[\s\S]*?min-height:\s*56px;[\s\S]*?border-bottom-color:\s*transparent;[\s\S]*?var\(--frost-tint\)/,
  'mobile right sidebar header should use the same dissolving glass language as the main header',
);

assert.match(
  rightSidebarCss,
  /@media \(max-width: 767px\)[\s\S]*?\.right-sidebar-big-button\s*\{[\s\S]*?min-height:\s*76px;[\s\S]*?border-color:\s*transparent;[\s\S]*?background:\s*var\(--sidebar-glass-fallback/,
  'mobile right sidebar action rows should use the deeper sidebar glass material',
);

assert.match(
  glassCss,
  /\.sidebar-workspace-popover,\s*\.header-overflow-menu,[\s\S]*?var\(--sidebar-glass-menu-fill\);[\s\S]*?backdrop-filter:\s*blur\(calc\(var\(--glass-blur\) \* 1\.05\)\) saturate\(1\.12\);/,
  'header overflow menu should join the existing sidebar menu glass treatment',
);

assert.match(
  glassCss,
  /@media \(max-width: 767px\)[\s\S]*?\.right-sidebar-header\s*\{[\s\S]*?backdrop-filter:\s*blur\(calc\(var\(--glass-blur\) \* 0\.64\)\) saturate\(1\.06\);/,
  'mobile right sidebar header should blur content beneath it in glass-capable browsers',
);

console.log('test-chat-mobile-menu-sidebar-style: ok');
