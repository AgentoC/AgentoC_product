import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { CONTINUITY_INVARIANTS, digestEvents, reduceContinuityEvents } from '../chat/continuity-core.mjs';

// I-CTX-007 (REDUCE_BOUNDED): the continuity reducer runs on the run
// finalization critical path. An O(n·|state|) reducer (full structuredClone of
// the accumulated state per event) blocked the event loop for 100s+ on a real
// 56k-event session, ran past systemd WatchdogSec=45s, and the resulting
// SIGABRT loop prevented the checkpoint write — the direct cause of a
// "session amnesia" incident (2026-08-15, session aa23380d). This test pins
// the copy-on-write reducer: reducing a large synthetic history must stay
// within a bounded CPU budget and remain deterministic.

function buildLargeHistory(eventCount) {
  const events = [];
  let seq = 1;
  while (events.length < eventCount) {
    events.push({ seq: seq++, type: 'message', role: 'assistant', content: `step ${seq}`, runId: 'run-1' });
    events.push({ seq: seq++, type: 'status', content: 'running', runId: 'run-1' });
    events.push({ seq: seq++, type: 'tool_result', toolName: 'npm test', output: `pass ${seq}\n${'x'.repeat(1200)}`, exitCode: 0, runId: 'run-1' });
    if (seq % 5 === 0) events.push({ seq: seq++, type: 'file_change', filePath: `src/file${seq}.mjs`, changeType: 'update', runId: 'run-1' });
  }
  return events.slice(0, eventCount);
}

// 20k events with ~6.7k accumulated validations mirrors the incident shape at
// a scale the test suite can afford. The old reducer needed >40s for this;
// the COW reducer must stay well under a generous CI-safe bound.
const events = buildLargeHistory(20_000);
assert.equal(events.at(-1).seq, events.length, 'synthetic history is contiguous');

const start = performance.now();
const state = reduceContinuityEvents('perf-session', events);
const elapsedMs = performance.now() - start;

assert.equal(state.revision, events.length);
assert.equal(state.coverage.coveredThroughSeq, events.length);
assert.equal(state.coverage.omittedRanges.length, 0);
assert.equal(state.validations.length > 3_000, true, `validations accumulate like the incident session (got ${state.validations.length})`);
assert.equal(state.files.length > 1_000, true, 'files accumulate like the incident session');

// Determinism (I-CTX-004): the same events in a different input order must
// produce an identical state — the reducer sorts by seq before folding.
const reordered = [...events].reverse();
const reorderedState = reduceContinuityEvents('perf-session', reordered);
assert.deepEqual(reorderedState, state);

// Bounded reduce (I-CTX-007). CI machines vary, so the bound is generous
// (the pre-fix reducer measured 40,000ms+ at this size; the fix measured
// ~150ms on the same hardware). The regression this guards against is two
// orders of magnitude, not the last 10%.
const REDUCE_BUDGET_MS = 5_000;
assert.equal(
  elapsedMs < REDUCE_BUDGET_MS,
  true,
  `reduce of 20k events took ${elapsedMs.toFixed(0)}ms (budget ${REDUCE_BUDGET_MS}ms) — reducer regressed to unbounded cloning (I-CTX-007)`,
);

// The digest must also stay linear-cheap and content-addressed.
const digestStart = performance.now();
const digest = digestEvents(events);
const digestMs = performance.now() - digestStart;
assert.match(digest, /^sha256:[0-9a-f]{64}$/);
assert.equal(digestMs < 2_000, true, `digest of 20k events took ${digestMs.toFixed(0)}ms`);

assert.equal(CONTINUITY_INVARIANTS.REDUCE_BOUNDED, 'I-CTX-007');
console.log(`test-continuity-reduce-perf: ok (reduce ${elapsedMs.toFixed(0)}ms, digest ${digestMs.toFixed(0)}ms for ${events.length} events)`);
