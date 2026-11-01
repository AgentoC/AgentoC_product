#!/usr/bin/env node
// P1 focused unit test: verify buildContextCompactionPrompt switches between
// full-replace, incremental-merge, and periodic-rewrite modes based on the
// mergeMode / forceRewrite flags derived from compactionCount.
//
// This is intentionally a pure-logic test (no runner-supervisor, no fake
// provider subprocess) so it stays green regardless of the pre-existing
// environmental breakage in the heavier tests/test-auto-compaction.mjs
// integration test (its runner path normalizes 0 events on this host — a
// separate infrastructure defect, unrelated to the compaction prompt logic).

import assert from 'assert/strict';
import { buildContextCompactionPrompt } from '../chat/session-auto-compaction.mjs';

const baseArgs = {
  session: { systemPrompt: 'parent app instructions' },
  conversationBody: 'user: did X\nassistant: did Y',
  toolIndex: '- ran grep\n- edited file',
  automatic: true,
};

// 1) First-ever compaction: no prior summary → full replace, regardless of flags.
const firstPrompt = buildContextCompactionPrompt({
  ...baseArgs,
  existingSummary: '',
  mergeMode: false,
  forceRewrite: false,
});
assert.ok(
  firstPrompt.includes('Replace older context with a fresh continuation package.'),
  'first compaction (no prior summary) should use the full-replace goal',
);
assert.ok(
  !firstPrompt.includes('Goal (incremental merge)'),
  'first compaction should NOT use the incremental-merge goal',
);

// 2) Incremental merge: prior summary exists, mergeMode on, not a rewrite tick.
const mergePrompt = buildContextCompactionPrompt({
  ...baseArgs,
  existingSummary: 'EXISTING CARRIED SUMMARY with durable facts',
  mergeMode: true,
  forceRewrite: false,
});
assert.ok(
  mergePrompt.includes('Goal (incremental merge)'),
  'with a prior summary + mergeMode, prompt should use the incremental-merge goal',
);
assert.ok(
  mergePrompt.includes('The existing summary is authoritative'),
  'incremental-merge prompt should mark the existing summary as authoritative',
);
assert.ok(
  mergePrompt.includes('EXISTING CARRIED SUMMARY with durable facts'),
  'incremental-merge prompt should embed the existing summary for the worker to merge into',
);
assert.ok(
  !mergePrompt.includes('periodic rewrite'),
  'a normal incremental merge should NOT request a periodic full rewrite',
);

// 3) Periodic rewrite: prior summary exists, mergeMode on, forceRewrite tick.
const rewritePrompt = buildContextCompactionPrompt({
  ...baseArgs,
  existingSummary: 'EXISTING CARRIED SUMMARY with durable facts',
  mergeMode: true,
  forceRewrite: true,
});
assert.ok(
  rewritePrompt.includes('periodic rewrite'),
  'forceRewrite should switch the prompt to the periodic full-rewrite goal',
);
assert.ok(
  rewritePrompt.includes('Regenerate the continuation summary from scratch'),
  'periodic-rewrite prompt should instruct a from-scratch regeneration',
);
assert.ok(
  rewritePrompt.includes('EXISTING CARRIED SUMMARY with durable facts'),
  'periodic-rewrite prompt should still synthesize from the existing summary',
);

// 4) mergeMode requested but the prior summary is empty/[none] → must fall back
//    to full replace (guards against merging into a nonexistent base).
const emptyBaseMerge = buildContextCompactionPrompt({
  ...baseArgs,
  existingSummary: '',
  mergeMode: true,
  forceRewrite: false,
});
assert.ok(
  emptyBaseMerge.includes('Replace older context with a fresh continuation package.'),
  'mergeMode with an empty prior summary should fall back to full replace',
);
assert.ok(
  !emptyBaseMerge.includes('Goal (incremental merge)'),
  'mergeMode with an empty prior summary should NOT emit the incremental-merge goal',
);

console.log('test-context-compaction-merge-mode: ok');
