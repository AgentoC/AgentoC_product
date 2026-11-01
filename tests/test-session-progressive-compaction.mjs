// P2a focused unit test: getProgressiveCompactionLevel thresholds
// Uses pure data in -> level out; no I/O, no services, no runner.

import { COMPACTION_LEVEL, getProgressiveCompactionLevel } from '../chat/session-auto-compaction.mjs';

const WINDOW = 200000;

function makeRun(overrides = {}) {
  return {
    contextInputTokens: 0,
    contextWindowTokens: WINDOW,
    ...overrides,
  };
}

function check(label, run, expected) {
  const actual = getProgressiveCompactionLevel(run);
  if (actual !== expected) {
    console.error(`FAIL [${label}]: expected ${expected}, got ${actual}`);
    process.exit(1);
  }
}

// --- threshold boundaries ---

// 49%: below all thresholds -> NONE
check('below trim (49%)', makeRun({ contextInputTokens: Math.floor(WINDOW * 0.49) }), COMPACTION_LEVEL.NONE);
// 0% edge case
check('zero tokens', makeRun({ contextInputTokens: 0 }), COMPACTION_LEVEL.NONE);

// 50% (default TOOL_TRIM threshold): level 1
check('at trim threshold (50%)', makeRun({ contextInputTokens: Math.floor(WINDOW * 0.50) }), COMPACTION_LEVEL.TRIM_TOOLS);
// 60%: still trim zone
check('mid trim zone (60%)', makeRun({ contextInputTokens: Math.floor(WINDOW * 0.60) }), COMPACTION_LEVEL.TRIM_TOOLS);

// 70% (default COMPACT threshold): level 2
check('at compact threshold (70%)', makeRun({ contextInputTokens: Math.floor(WINDOW * 0.70) }), COMPACTION_LEVEL.COMPACT);
// 80%: still compact zone
check('mid compact zone (80%)', makeRun({ contextInputTokens: Math.floor(WINDOW * 0.80) }), COMPACTION_LEVEL.COMPACT);

// 85% (default EMERGENCY threshold): level 3
check('at emergency threshold (85%)', makeRun({ contextInputTokens: Math.floor(WINDOW * 0.85) }), COMPACTION_LEVEL.EMERGENCY);
// 95%: still emergency
check('deep emergency (95%)', makeRun({ contextInputTokens: Math.floor(WINDOW * 0.95) }), COMPACTION_LEVEL.EMERGENCY);
// 100%: emergency
check('window full (100%)', makeRun({ contextInputTokens: WINDOW }), COMPACTION_LEVEL.EMERGENCY);

// --- codex-app-server-json always returns NONE ---
check('codex-app-server-json at 90% (native compact on by default)',
  makeRun({ contextInputTokens: Math.floor(WINDOW * 0.90), runtimeFamily: 'codex-app-server-json' }),
  COMPACTION_LEVEL.NONE);

// --- non-codex family still returns correct level ---
check('claude-stream-json-bidi at 75%',
  makeRun({ contextInputTokens: Math.floor(WINDOW * 0.75), runtimeFamily: 'claude-stream-json-bidi' }),
  COMPACTION_LEVEL.COMPACT);

// --- missing window tokens -> NONE ---
check('missing contextWindowTokens',
  makeRun({ contextInputTokens: 1000, contextWindowTokens: undefined }),
  COMPACTION_LEVEL.NONE);

// --- missing input tokens -> NONE ---
check('missing contextInputTokens',
  makeRun({ contextInputTokens: undefined, contextWindowTokens: WINDOW }),
  COMPACTION_LEVEL.NONE);

// --- zero window -> NONE ---
check('zero contextWindowTokens',
  makeRun({ contextInputTokens: 1000, contextWindowTokens: 0 }),
  COMPACTION_LEVEL.NONE);

// --- negative window -> NONE ---
check('negative contextWindowTokens',
  makeRun({ contextInputTokens: 1000, contextWindowTokens: -1 }),
  COMPACTION_LEVEL.NONE);

console.log('test-session-progressive-compaction: ok');
process.exit(0);
