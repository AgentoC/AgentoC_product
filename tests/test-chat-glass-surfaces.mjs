#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const chatCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat.css'), 'utf8');
const glassCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-glass.css'), 'utf8');

assert.match(chatCss, /@import url\("chat-glass\.css"\);/, 'glass surface overrides should load after the core chat styles');
assert.match(glassCss, /--glass-blur:\s*22px;/, 'glass surfaces should expose a shared blur token');
assert.match(glassCss, /--surface-glass-base:\s*color-mix\(in srgb, var\(--user-bubble\) 72%, var\(--bg-tertiary\) 28%\);/, 'sent bubble glass should use the existing gray bubble token instead of washing out to white');
assert.match(glassCss, /--surface-glass-strong-base:\s*color-mix\(in srgb, var\(--surface-hover\) 54%, var\(--bg-secondary\) 46%\);/, 'remaining glass surfaces should keep the shared strong surface token');
assert.match(glassCss, /--glass-sheen:\s*linear-gradient\(/, 'glass surfaces should include a subtle refraction layer so blur is visible on plain chat backgrounds');
assert.doesNotMatch(glassCss, /\.input-wrapper\s*\{|\.input-actions-row\s*\{|composer-glass-fill|backdrop-filter:\s*blur\(22px\)/, 'composer should not be coupled to the legacy glass stylesheet');
assert.match(glassCss, /\.msg-user-bubble\s*\{[\s\S]*?background:\s*[\s\S]*?var\(--glass-sheen\),[\s\S]*?color-mix\(in srgb, var\(--surface-glass-base\) 68%, transparent\);[\s\S]*?-webkit-backdrop-filter:\s*blur\(calc\(var\(--glass-blur\) \* 0\.77\)\) saturate\(1\.08\);[\s\S]*?backdrop-filter:\s*blur\(calc\(var\(--glass-blur\) \* 0\.77\)\) saturate\(1\.08\);/, 'sent bubbles should share the composer frost parameters (68% base, blur * 0.77, saturate 1.08) so both surfaces read as the same material');
assert.match(glassCss, /\.msg-user-bubble\.msg-failed\s*\{[\s\S]*?border-color:\s*var\(--failed-message-border\);[\s\S]*?\}/, 'failed sent bubbles should preserve the explicit warning border');
assert.doesNotMatch(glassCss, /#fff(?:fff)?|rgba\(255,\s*255,\s*255/, 'glass polish should avoid hard-coded white highlights that read as bright lines in dark mode');

console.log('test-chat-glass-surfaces: ok');
