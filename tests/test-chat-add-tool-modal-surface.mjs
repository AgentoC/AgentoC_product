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

const modalBlock = cssRuleBlock(inputCss, '.modal');
const modalHeaderBlock = cssRuleBlock(inputCss, '.modal-header');
const providerInputBlock = cssRuleBlock(inputCss, '.provider-helper-field input');
const providerCardBlock = cssRuleBlock(inputCss, '.provider-helper-card');
const inlineCodeBlock = cssRuleBlock(inputCss, '.provider-helper-card code.inline-code');
const codeBlock = cssRuleBlock(inputCss, '.provider-helper-code');

assert.match(modalBlock, /background:\s*var\(--surface-raised, var\(--bg\)\);/, 'add-agent modal should use a raised surface fallback');
assert.match(modalBlock, /border:\s*1px solid transparent;/, 'add-agent modal should not use a hard border');
assert.match(modalBlock, /box-shadow:[\s\S]*?var\(--shadow-floating,[\s\S]*?var\(--divider-subtle\)/, 'add-agent modal should use floating shadow and subtle inset structure');
assert.doesNotMatch(modalBlock, /border:\s*1px solid var\(--border\);/, 'add-agent modal should not keep the previous hard outline');

assert.match(
  inputCss,
  /@supports \(\(backdrop-filter:\s*blur\(1px\)\) or \(-webkit-backdrop-filter:\s*blur\(1px\)\)\) \{[\s\S]*?\.modal\s*\{[\s\S]*?-webkit-backdrop-filter:\s*blur\(calc\(var\(--glass-blur,\s*18px\) \* 0\.78\)\) saturate\(1\.08\);[\s\S]*?backdrop-filter:\s*blur\(calc\(var\(--glass-blur,\s*18px\) \* 0\.78\)\) saturate\(1\.08\);/,
  'add-agent modal should become a frosted sheet when backdrop-filter is supported',
);
assert.match(modalHeaderBlock, /border-bottom:\s*1px solid color-mix\(in srgb, var\(--divider-subtle\) 62%, transparent\);/, 'modal header should use a subtle divider');
assert.match(
  inputCss,
  /\.modal-footer\s*\{[\s\S]*?justify-content:\s*flex-end;[\s\S]*?border-top:\s*1px solid color-mix\(in srgb, var\(--divider-subtle\) 62%, transparent\);/,
  'modal footer should use a subtle divider',
);

assert.match(
  inputCss,
  /\.modal-close,\s*\.modal-btn\s*\{[\s\S]*?background:\s*var\(--surface-soft, transparent\);[\s\S]*?border:\s*1px solid transparent;[\s\S]*?box-shadow:\s*none;/,
  'modal buttons should be borderless soft controls at rest',
);
assert.match(providerInputBlock, /border:\s*1px solid transparent;/, 'provider helper inputs should avoid hard outlines');
assert.match(providerInputBlock, /background:\s*var\(--surface-soft, var\(--bg\)\);/, 'provider helper inputs should use the shared soft input surface');
assert.match(providerInputBlock, /box-shadow:\s*inset 0 0 0 1px color-mix\(in srgb, var\(--divider-subtle\) 72%, transparent\);/, 'provider helper inputs should use subtle inset structure');
assert.match(providerCardBlock, /border:\s*1px solid transparent;/, 'provider helper cards should avoid hard outlines');
assert.match(providerCardBlock, /background:\s*var\(--surface-soft, var\(--bg-secondary\)\);/, 'provider helper cards should use soft surfaces');
assert.match(providerCardBlock, /box-shadow:[\s\S]*?var\(--shadow-soft,[\s\S]*?var\(--divider-subtle\)/, 'provider helper cards should use soft shadow and subtle inset structure');
assert.match(inlineCodeBlock, /border:\s*1px solid transparent;/, 'inline provider code should avoid hard borders');
assert.match(codeBlock, /border:\s*1px solid transparent;/, 'provider setup code should avoid hard borders');

console.log('test-chat-add-tool-modal-surface: ok');
