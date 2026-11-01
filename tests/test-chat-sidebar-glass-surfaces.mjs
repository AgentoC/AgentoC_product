#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const glassCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-glass.css'), 'utf8');

assert.match(
  glassCss,
  /--sidebar-tab-shell:\s*color-mix\(in srgb, var\(--bg-tertiary\) 66%, var\(--border\) 34%\);/,
  'sidebar tab shell should use a deeper gray derived from theme surfaces',
);

assert.match(
  glassCss,
  /--sidebar-glass-base:\s*color-mix\(in srgb, var\(--surface-hover\) 78%, var\(--bg-secondary\) 22%\);[\s\S]*?--sidebar-glass-fallback:\s*color-mix\(in srgb, var\(--surface-hover\) 88%, var\(--bg-secondary\) 12%\);[\s\S]*?--sidebar-glass-fill:\s*color-mix\(in srgb, var\(--sidebar-glass-base\) 68%, transparent\);[\s\S]*?--sidebar-glass-menu-fill:\s*color-mix\(in srgb, var\(--sidebar-glass-base\) 58%, transparent\);/,
  'sidebar glass should use lower-opacity deep gray material tokens',
);

assert.match(
  glassCss,
  /--sidebar-glass-shadow:[\s\S]*?0 5px 14px color-mix\(in srgb, var\(--text\) 8%, transparent\),[\s\S]*?inset 0 0 0 1px var\(--glass-edge\);[\s\S]*?--sidebar-glass-floating-shadow:[\s\S]*?0 12px 30px color-mix\(in srgb, var\(--text\) 12%, transparent\),[\s\S]*?inset 0 0 0 1px var\(--glass-edge\);/,
  'sidebar glass should define subtle shadows for controls and floating menus',
);

assert.match(
  glassCss,
  /\.sidebar-tabs\s*\{[\s\S]*?background:\s*var\(--sidebar-tab-shell\);[\s\S]*?box-shadow:\s*var\(--sidebar-glass-shadow\);/,
  'sidebar tabs should render as a gray segmented bar with subtle shadow',
);

assert.match(
  glassCss,
  /\.sidebar-workspace,\s*\.sidebar-search-input,[\s\S]*?\.sidebar-workspace \.custom-select-wrap\.cs-full-bg \.cs-trigger,[\s\S]*?\.custom-select-panel\[aria-labelledby="workspaceBrowserSelect-cs-trigger"\]\s*\{[\s\S]*?background:\s*var\(--sidebar-glass-fallback\);[\s\S]*?box-shadow:\s*var\(--sidebar-glass-shadow\);/,
  'sidebar workspace, search, and workspace dropdowns should share glass surface and subtle shadow',
);

assert.match(
  glassCss,
  /\.session-item\.active\s*\{[\s\S]*?box-shadow:\s*var\(--sidebar-glass-shadow\);/,
  'active session block should use the sidebar glass shadow',
);

assert.match(
  glassCss,
  /\.sidebar,\s*\.sidebar \*,[\s\S]*?\.custom-select-panel\[aria-labelledby="workspaceBrowserSelect-cs-trigger"\] \*\s*\{[\s\S]*?box-shadow:\s*none !important;/,
  'sidebar still suppresses inherited shadows before restoring the intended glass shadows',
);

assert.match(
  glassCss,
  /\.sidebar \.sidebar-tabs,[\s\S]*?\.sidebar \.session-item\.active\s*\{[\s\S]*?box-shadow:\s*var\(--sidebar-glass-shadow\) !important;/,
  'the final sidebar shadow override should restore subtle shadows to sidebar controls and bars',
);

assert.match(
  glassCss,
  /\.custom-select-panel\[aria-labelledby="workspaceSelect-cs-trigger"\],[\s\S]*?\.custom-select-panel\[aria-labelledby="workspaceBrowserSelect-cs-trigger"\]\s*\{[\s\S]*?box-shadow:\s*var\(--sidebar-glass-floating-shadow\) !important;/,
  'floating sidebar dropdown panels should use the subtle floating glass shadow',
);

assert.match(
  glassCss,
  /\.custom-select-panel\[aria-labelledby="workspaceSelect-cs-trigger"\],[\s\S]*?\.custom-select-panel\[aria-labelledby="workspaceCustomFolderSelect-cs-trigger"\],[\s\S]*?\.custom-select-panel\[aria-labelledby="workspaceBrowserSelect-cs-trigger"\]/,
  'workspace dropdown panels should be covered even when floated to document.body',
);

assert.match(
  glassCss,
  /@supports \(\(backdrop-filter:\s*blur\(1px\)\) or \(-webkit-backdrop-filter:\s*blur\(1px\)\)\) \{[\s\S]*?\.sidebar-workspace,\s*\.sidebar-search-input,[\s\S]*?\.session-item\.active,[\s\S]*?\.custom-select-panel\[aria-labelledby="workspaceBrowserSelect-cs-trigger"\]\s*\{[\s\S]*?background:[\s\S]*?var\(--sidebar-glass-fill\);[\s\S]*?-webkit-backdrop-filter:\s*blur\(calc\(var\(--glass-blur\) \* 0\.77\)\) saturate\(1\.08\);[\s\S]*?backdrop-filter:\s*blur\(calc\(var\(--glass-blur\) \* 0\.77\)\) saturate\(1\.08\);/,
  'sidebar glass surfaces should keep composer blur while using the darker sidebar fill',
);

assert.match(
  glassCss,
  /\.sidebar-workspace-popover,\s*\.header-overflow-menu,[\s\S]*?\.custom-select-panel,[\s\S]*?\.composer-permission-menu\s*\{[\s\S]*?var\(--sidebar-glass-menu-fill\);[\s\S]*?-webkit-backdrop-filter:\s*blur\(calc\(var\(--glass-blur\) \* 1\.05\)\) saturate\(1\.12\);[\s\S]*?backdrop-filter:\s*blur\(calc\(var\(--glass-blur\) \* 1\.05\)\) saturate\(1\.12\);/,
  'workspace dropdown panels and the mobile header menu should use a more visibly frosted menu glass',
);

assert.match(
  glassCss,
  /@supports \(\(backdrop-filter:\s*blur\(1px\)\) or \(-webkit-backdrop-filter:\s*blur\(1px\)\)\) \{[\s\S]*?\.session-item\.active\s*\{[\s\S]*?box-shadow:\s*var\(--sidebar-glass-shadow\);/,
  'active session should keep the sidebar glass shadow in backdrop-filter capable browsers',
);

console.log('test-chat-sidebar-glass-surfaces: ok');
