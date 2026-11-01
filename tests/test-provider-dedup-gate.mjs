#!/usr/bin/env node
import assert from 'assert/strict';
import {
  buildKnownDedupKeySet,
  filterDuplicateProviderEvents,
  filterUnknownProviderEvents,
  getProviderEventDedupKey,
  shouldSkipDedupLoad,
} from '../chat/provider-event-dedup.mjs';

const keyedEvent = (type, runId, providerId) => {
  if (type === 'message') {
    return { type, role: 'assistant', runId, providerMessageId: providerId, content: 'Done.' };
  }
  if (type === 'tool_use') {
    return { type, role: 'assistant', runId, providerToolUseId: providerId, toolName: 'Bash', toolInput: '{}' };
  }
  return { type, runId, providerToolUseId: providerId, filePath: '/tmp/a.js', changeType: 'edit', added: 1, removed: 1 };
};

const noKeyEvent = { type: 'status', runId: 'run-1', content: 'completed' };

// --- buildKnownDedupKeySet ---
assert.equal(getProviderEventDedupKey(keyedEvent('message', 'run-1', 'msg-1')), JSON.stringify(['run-1', 'message', 'assistant', 'msg-1', null, 'Done.']));
const known = buildKnownDedupKeySet([
  keyedEvent('message', 'run-1', 'msg-1'),
  keyedEvent('tool_use', 'run-1', 'tool-1'),
  noKeyEvent, // events without a provider identity are skipped
]);
assert.equal(known.size, 2, 'only provider-identified events yield dedup keys');

// --- shouldSkipDedupLoad: skip only when EVERY candidate has a known key ---
assert.equal(
  shouldSkipDedupLoad({ knownKeys: known, candidates: [keyedEvent('message', 'run-1', 'msg-1')] }),
  true,
  'all candidates known → skip the history load',
);
assert.equal(
  shouldSkipDedupLoad({ knownKeys: known, candidates: [keyedEvent('message', 'run-1', 'msg-1'), keyedEvent('tool_use', 'run-1', 'tool-1')] }),
  true,
  'multiple known candidates → skip',
);
assert.equal(
  shouldSkipDedupLoad({ knownKeys: known, candidates: [keyedEvent('message', 'run-1', 'msg-2')] }),
  false,
  'unknown candidate key → must load',
);
assert.equal(
  shouldSkipDedupLoad({ knownKeys: known, candidates: [keyedEvent('message', 'run-1', 'msg-1'), noKeyEvent] }),
  false,
  'a candidate without a key can never be proven duplicate → must load (it passes through the filter)',
);
assert.equal(
  shouldSkipDedupLoad({ knownKeys: null, candidates: [keyedEvent('message', 'run-1', 'msg-1')] }),
  false,
  'no known set → must load',
);
assert.equal(
  shouldSkipDedupLoad({ knownKeys: known, candidates: [] }),
  true,
  'empty candidate list vacuously skips',
);

// --- skip-consistency: a skipped tick produces exactly what the filter would
// produce for an all-known batch: nothing. ---
const skipped = shouldSkipDedupLoad({ knownKeys: known, candidates: [keyedEvent('message', 'run-1', 'msg-1')] });
assert.equal(skipped, true);
assert.deepEqual(
  filterDuplicateProviderEvents([keyedEvent('message', 'run-1', 'msg-1')], [keyedEvent('message', 'run-1', 'msg-1')]),
  [],
  'the filter agrees: an all-known batch yields zero durable events',
);
assert.deepEqual(
  filterDuplicateProviderEvents([], [noKeyEvent]),
  [noKeyEvent],
  'the filter passes no-key events through — which is why they force a load',
);

// --- filterUnknownProviderEvents: the active-run shortcut ---
// With a seeded (authoritative) set, known keys are re-emissions (dropped),
// unknown keys are new by construction (kept, no history load needed), and
// no-key events always pass through.
const seeded = buildKnownDedupKeySet([keyedEvent('message', 'run-1', 'msg-1')]);
assert.deepEqual(
  filterUnknownProviderEvents(
    [keyedEvent('message', 'run-1', 'msg-1'), keyedEvent('tool_use', 'run-1', 'tool-2'), noKeyEvent],
    seeded,
  ).map((event) => event.type || event.content),
  ['tool_use', 'status'],
  'known key dropped, unknown key kept, no-key kept',
);
assert.deepEqual(
  filterUnknownProviderEvents([keyedEvent('message', 'run-1', 'msg-1')], seeded),
  [],
  'all-known batch yields nothing (same result as shouldSkipDedupLoad)',
);
assert.deepEqual(
  filterUnknownProviderEvents([keyedEvent('message', 'run-1', 'msg-2')], seeded),
  [keyedEvent('message', 'run-1', 'msg-2')],
  'unknown key kept verbatim — it can never be a duplicate of persisted history',
);
assert.equal(
  filterUnknownProviderEvents(
    [keyedEvent('message', 'run-1', 'msg-2'), keyedEvent('message', 'run-1', 'msg-2')],
    seeded,
  ).length,
  1,
  'duplicate unknown keys in one batch collapse before append',
);
assert.deepEqual(
  filterUnknownProviderEvents([keyedEvent('message', 'run-1', 'msg-1')], null),
  [keyedEvent('message', 'run-1', 'msg-1')],
  'null set passes everything through — callers must fall back to a history load',
);

console.log('test-provider-dedup-gate: ok');
