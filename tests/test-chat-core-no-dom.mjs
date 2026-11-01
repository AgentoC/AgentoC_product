#!/usr/bin/env node
// tests/test-chat-core-no-dom.mjs
//
// Stage 0 guard: static/chat/core/ must stay free of DOM/browser/global tokens,
// so the client core can run in a plain Node (or non-browser) environment and be
// reused by a future native client. This test is the "basis" — in Stage 0 the
// directory does not exist yet, so the scan is vacuous and the test passes; the
// moment Stage 1 populates core/, the same scan starts enforcing the boundary.
//
// See docs/frontend-core-contract.md §4–5.

import assert from 'assert/strict';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { scanForForbidden, DEFAULT_FORBIDDEN, formatHits } from '../lib/no-dom-scanner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const coreDir = join(repoRoot, 'static/chat/core');

// The forbidden list itself must be meaningful — guard the guard.
assert.ok(
  DEFAULT_FORBIDDEN.length >= 10,
  'no-dom-scanner must define a non-trivial forbidden token list',
);
assert.ok(
  ['window', 'document', 'fetch', 'WebSocket', 'innerHTML', 'className'].every((t) =>
    DEFAULT_FORBIDDEN.includes(t)),
  'forbidden list must cover the core DOM/browser/global surface',
);

if (!existsSync(coreDir)) {
  // Stage 0: core/ does not exist yet. The boundary rule is documented and the
  // scanner is wired; enforcement activates automatically in Stage 1.
  console.log('test-chat-core-no-dom: ok (core/ not yet created — guard armed for Stage 1)');
} else {
  const hits = scanForForbidden(coreDir, DEFAULT_FORBIDDEN, { repoRoot });
  assert.equal(
    hits.length,
    0,
    `static/chat/core/ must not reference DOM/browser globals.\nForbidden hits:\n${formatHits(hits)}\n` +
      'Move presentation/platform concerns to views/dom/ or platform/web/. See docs/frontend-core-contract.md.',
  );
  console.log('test-chat-core-no-dom: ok');
}
