#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const inputCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-input.css'), 'utf8');

function cssRuleBlock(stylesheet, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = stylesheet.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `expected ${selector} rule to exist`);
  return match[1];
}

const stripBlock = cssRuleBlock(inputCss, '.img-preview-strip.has-images');
const itemBlock = cssRuleBlock(inputCss, '.img-preview-item');
const fileBlock = cssRuleBlock(inputCss, '.img-preview-item .attachment-file');
const removeBlock = cssRuleBlock(inputCss, '.img-preview-item .remove-img');
const badgeBlock = cssRuleBlock(inputCss, '.img-preview-item .attachment-upload-badge');
const retryBlock = cssRuleBlock(inputCss, '.img-preview-item .retry-img-upload');

assert.match(stripBlock, /border-bottom-color:\s*transparent;/, 'attachment preview strip should not restore a hard divider when visible');
assert.match(stripBlock, /background:\s*color-mix\(in srgb, var\(--surface-soft\) 36%, transparent\);/, 'attachment preview strip should use a soft neutral fill');
assert.match(stripBlock, /box-shadow:\s*inset 0 -1px 0 color-mix\(in srgb, var\(--divider-subtle\) 46%, transparent\);/, 'attachment preview strip should use a subtle divider shadow');
assert.doesNotMatch(stripBlock, /border-bottom-color:\s*var\(--border\);/, 'attachment preview strip should not use the old hard border color');

assert.match(itemBlock, /border:\s*1px solid transparent;/, 'attachment preview items should be borderless at rest');
assert.match(itemBlock, /background:\s*var\(--surface-soft, var\(--bg-secondary\)\);/, 'attachment preview items should use the shared soft surface');
assert.match(itemBlock, /box-shadow:[\s\S]*?var\(--shadow-soft,[\s\S]*?var\(--divider-subtle\)/, 'attachment preview items should use soft shadow and subtle inset structure');
assert.doesNotMatch(itemBlock, /border:\s*1px solid var\(--border\);/, 'attachment preview items should not use hard outlines');

assert.match(fileBlock, /background:[\s\S]*?var\(--glass-sheen,[\s\S]*?var\(--surface-soft, var\(--bg-secondary\)\);/, 'generic file previews should share the glass/soft composer language');
assert.match(inputCss, /\.img-preview-item\.is-uploaded\s*\{[\s\S]*?inset 0 -3px 0 color-mix\(in srgb, var\(--success\) 54%, transparent\);/, 'uploaded previews should show status as a small accent strip');
assert.match(inputCss, /\.img-preview-item\.is-failed\s*\{[\s\S]*?inset 0 -3px 0 color-mix\(in srgb, var\(--issue\) 68%, transparent\);/, 'failed previews should show status as a small accent strip');

assert.doesNotMatch(removeBlock, /color:\s*white;/, 'remove buttons should not hard-code white text');
assert.doesNotMatch(badgeBlock, /rgba\(17,\s*17,\s*17|color:\s*white;/, 'upload badges should avoid the old hard-coded black/white treatment');
assert.doesNotMatch(retryBlock, /black\)|color:\s*white;/, 'retry badges should avoid hard-coded black/white treatment');

console.log('test-chat-composer-attachment-preview-surface: ok');
