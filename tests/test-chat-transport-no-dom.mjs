#!/usr/bin/env node
// tests/test-chat-transport-no-dom.mjs
//
// Stage 2 guard: static/chat/transport/ must stay free of DOM/browser/global
// tokens, so the transport layer (request scheduling, event normalization,
// snapshot caching) can run in a plain Node environment and be exercised by
// Node tests — and potentially reused by a future native client. The scan
// activates automatically once transport/ is populated, mirroring the Stage 0
// core/ guard (tests/test-chat-core-no-dom.mjs).
//
// See docs/frontend-core-contract.md §4–5.

import assert from 'assert/strict';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { scanForForbidden, DEFAULT_FORBIDDEN, formatHits } from '../lib/no-dom-scanner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const transportDir = join(repoRoot, 'static/chat/transport');

if (!existsSync(transportDir)) {
  // Stage 2 not started yet: the boundary rule is documented and the scanner
  // is wired; enforcement activates automatically when transport/ appears.
  console.log('test-chat-transport-no-dom: ok (transport/ not yet created — guard armed for Stage 2)');
} else {
  const hits = scanForForbidden(transportDir, DEFAULT_FORBIDDEN, { repoRoot });
  assert.equal(
    hits.length,
    0,
    `static/chat/transport/ must not reference DOM/browser globals.\nForbidden hits:\n${formatHits(hits)}\n` +
      'Move platform/browser concerns to platform/web/ or the caller. See docs/frontend-core-contract.md.',
  );
  console.log('test-chat-transport-no-dom: ok');
}
