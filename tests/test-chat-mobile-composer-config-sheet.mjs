#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const responsiveCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-responsive.css'), 'utf8');

assert.match(
  responsiveCss,
  /@media\s*\(max-width:\s*767px\)\s*\{[\s\S]*?\.input-area\.composer-config-open \.input-config-group\.left\s*\{[\s\S]*?border:\s*1px solid transparent;[\s\S]*?border-radius:\s*var\(--radius-sheet-top,\s*24px\)\s*var\(--radius-sheet-top,\s*24px\)\s*18px\s*18px;[\s\S]*?background:\s*var\(--surface-glass-strong,/,
  'mobile composer config panel should use the shared glass sheet surface instead of a hard bordered panel',
);

assert.match(
  responsiveCss,
  /\.input-area\.composer-config-open \.input-config-group\.left\s*\{[\s\S]*?-webkit-backdrop-filter:\s*blur\(calc\(var\(--glass-blur,\s*18px\) \* 0\.9\)\) saturate\(1\.12\);[\s\S]*?backdrop-filter:\s*blur\(calc\(var\(--glass-blur,\s*18px\) \* 0\.9\)\) saturate\(1\.12\);/,
  'mobile composer config panel should keep visible frosted blur on supported browsers',
);

assert.match(
  responsiveCss,
  /\.tool-select,\s*\.model-select,\s*\.effort-select,\s*\.thinking-toggle,\s*\.compact-btn\s*\{[\s\S]*?min-height:\s*52px;[\s\S]*?background:\s*var\(--surface-soft,\s*var\(--bg-secondary\)\);[\s\S]*?border-color:\s*transparent;[\s\S]*?box-shadow:\s*inset 0 0 0 1px color-mix\(in srgb, var\(--divider-subtle,/,
  'mobile composer config controls should use soft surfaces and subtle dividers',
);

assert.match(
  responsiveCss,
  /\.input-config-group\.left \.custom-select-wrap \.cs-trigger\s*\{[\s\S]*?background:\s*var\(--surface-soft,\s*var\(--bg-secondary\)\);[\s\S]*?border-color:\s*transparent;[\s\S]*?box-shadow:\s*inset 0 0 0 1px color-mix\(in srgb, var\(--divider-subtle,/,
  'mobile custom select triggers should avoid hard outlines and white top highlights',
);

assert.match(
  responsiveCss,
  /#contextTokens\s*\{[\s\S]*?border:\s*1px solid transparent;[\s\S]*?background:\s*var\(--surface-soft,\s*var\(--bg-secondary\)\);/,
  'mobile context token chip should use a soft pill surface',
);

assert.match(
  responsiveCss,
  /\.composer-runtime-menu\.composer-menu--sheet,\s*\.composer-permission-menu\.composer-menu--sheet\s*\{[\s\S]*?width:\s*calc\(100vw\s*-\s*16px\);[\s\S]*?border-color:\s*transparent;[\s\S]*?border-radius:\s*var\(--mx-r-control,\s*24px\) var\(--mx-r-control,\s*24px\) 12px 12px;[\s\S]*?background:\s*var\(--surface-glass-strong,[\s\S]*?backdrop-filter:\s*blur\(calc\(var\(--glass-blur,\s*18px\) \* 0\.88\)\) saturate\(1\.1\);/,
  'mobile runtime and permission menus should render as glass sheets (near-full width, mx-r-control radii)',
);

assert.match(
  responsiveCss,
  /\.composer-runtime-menu\.composer-menu--sheet \.composer-runtime-option[\s\S]*?min-height:\s*52px;/,
  'mobile sheet menu options should keep thumb-friendly 52px touch targets',
);

assert.match(
  responsiveCss,
  /\.composer-add-menu\s*\{[\s\S]*?border-color:\s*transparent;[\s\S]*?border-radius:\s*18px;[\s\S]*?background:\s*var\(--surface-glass-strong,[\s\S]*?backdrop-filter:\s*blur\(calc\(var\(--glass-blur,\s*18px\) \* 0\.88\)\) saturate\(1\.1\);/,
  'mobile composer add menu should share the glass floating surface',
);

assert.match(
  responsiveCss,
  /\.composer-add-menu-item\s*\{[\s\S]*?align-items:\s*center;[\s\S]*?min-height:\s*44px;[\s\S]*?border-radius:\s*12px;/,
  'mobile composer add menu items should have comfortable touch targets',
);

assert.match(
  responsiveCss,
  /\.composer-add-menu-item\.active,\s*\.composer-add-menu-item\[aria-checked="true"\]\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--accent\) 12%, var\(--surface-hover\)\);[\s\S]*?box-shadow:\s*inset 0 0 0 1px color-mix\(in srgb, var\(--accent\) 22%, var\(--divider-subtle\)\);/,
  'mobile checked add-menu items should use subtle accent fill instead of a hard outline',
);

assert.match(
  responsiveCss,
  /\.composer-plan-chip\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--notice\) 12%, var\(--surface-soft,[\s\S]*?box-shadow:\s*inset 0 0 0 1px color-mix\(in srgb, var\(--notice\) 24%, var\(--divider-subtle\)\);/,
  'mobile plan chip should use a subtle notice-tinted soft surface',
);

console.log('test-chat-mobile-composer-config-sheet: ok');
