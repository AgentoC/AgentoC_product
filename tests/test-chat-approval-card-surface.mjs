#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const messagesCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-messages.css'), 'utf8');
const glassCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-glass.css'), 'utf8');
const sheetCss = readFileSync(join(repoRoot, 'static', 'chat', 'chat-decision-sheet.css'), 'utf8');

function cssRuleBlock(stylesheet, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = stylesheet.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `expected ${selector} rule to exist`);
  return match[1];
}

function hasCssRule(stylesheet, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escapedSelector}\\s*\\{`).test(stylesheet);
}

// Since 2026-08-04 the in-stream approval card is removed on every viewport —
// the Decision Sheet is the single approval surface. These assertions pin the
// removal contract: card-only rules are gone, the shared parts stay (the sheet
// reuses them), and the auditable summary line keeps its styling.

// Card-only surfaces must be gone from both stylesheets.
assert.equal(hasCssRule(messagesCss, '.runtime-approval-card'), false, 'in-stream approval card container rule must be removed');
assert.equal(hasCssRule(messagesCss, '.runtime-approval-card__header'), false, 'card header rule must be removed');
assert.equal(hasCssRule(messagesCss, '.runtime-approval-card__actions'), false, 'card actions rule must be removed');
assert.equal(hasCssRule(messagesCss, '.runtime-approval-card__action'), false, 'card action button rule must be removed');
assert.equal(hasCssRule(glassCss, '.runtime-approval-card'), false, 'card glass rule must be removed from chat-glass.css');

// Shared parts (reused by the Decision Sheet) stay.
const optionBlock = cssRuleBlock(messagesCss, '.runtime-approval-card__option');
assert.match(optionBlock, /border:\s*1px solid transparent;/, 'option tile should not use a hard outline');
assert.match(optionBlock, /background:\s*var\(--surface-raised,\s*var\(--bg\)\)/, 'option tile should keep the raised soft-row surface');
assert.match(optionBlock, /box-shadow:\s*inset 0 0 0 1px var\(--divider-subtle/, 'option tile should use an inset divider edge');
cssRuleBlock(messagesCss, '.runtime-approval-card__detail');
cssRuleBlock(messagesCss, '.runtime-approval-card__detail-label');
cssRuleBlock(messagesCss, '.runtime-approval-card__prompt');
cssRuleBlock(messagesCss, '.runtime-approval-card__code');

// Auditable summary line keeps its styling.
const summaryBlock = cssRuleBlock(messagesCss, '.runtime-approval-summary');
assert.match(summaryBlock, /color:\s*var\(--text-muted\)/, 'summary should use muted text');
assert.match(summaryBlock, /font-size:\s*11px/, 'summary should stay compact');

// The Decision Sheet is now the single approval surface on every viewport —
// desktop adapts it to the message column instead of hiding it.
assert.match(
  sheetCss,
  /@media \(min-width:\s*768px\)\s*\{[\s\S]*?#decisionSheet\s*\{[\s\S]*?width:\s*min\(100%,\s*var\(--chat-column-width/,
  'desktop sheet must align to the centered message column (not hide)',
);

console.log('test-chat-approval-card-surface: ok (card removed, shared parts + summary kept)');
