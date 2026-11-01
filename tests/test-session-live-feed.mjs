import assert from 'node:assert/strict';
import { createSessionLiveFeed, publishAllLiveEvents } from '../chat/session-live-feed.mjs';
const feed = createSessionLiveFeed();
feed.publish('a', [{ type: 'text_delta', entityId: 'm', delta: 'l' }, { type: 'text_delta', entityId: 'm', delta: 'l' }]);
const first = feed.read('a'); assert.equal(first.liveEvents.length, 2);
assert.notEqual(first.liveEvents[0].eventId, first.liveEvents[1].eventId);
assert.deepEqual(feed.read('a'), first, 'retry has stable delivery identity');
assert.equal(feed.read('a', { afterCursor: first.liveCursor }).liveEvents.length, 0);
assert.equal(feed.read('b').liveEvents.length, 0, 'session isolation');
assert.equal(feed.read('a', { requestedStreamId: 'previous-process' }).liveResetRequired, true);
for (const cursor of [-1, NaN, Infinity, 0.5, 999]) assert.equal(feed.read('a', { afterCursor: cursor }).liveResetRequired, true);
const bounded = createSessionLiveFeed({ maximumEvents: 2 });
bounded.publish('a', Array.from({ length: 4 }, (_, n) => ({ type: 'text_delta', delta: String(n) })));
assert.equal(bounded.read('a').liveResetRequired, true, 'a missing prefix is never silently accepted');
assert.equal(bounded.read('a', { afterCursor: 2 }).liveEvents.length, 2);
bounded.publish('a', [{ type: 'text_delta', delta: 'x'.repeat(65536) }]);
assert.equal(bounded.read('a', { afterCursor: 4 }).liveResetRequired, true);
let now = 0; const expiring = createSessionLiveFeed({ clock: () => now, maximumSessions: 2, ttlMs: 10 });
for (const id of ['a', 'b', 'c']) expiring.publish(id, [{ type: 'text_delta', delta: id }]);
assert.equal(expiring.stats().sessions, 2); assert.equal(expiring.read('a').liveEvents.length, 0);
now = 10; assert.deepEqual(expiring.stats(), { sessions: 0, bytes: 0 });
const page = createSessionLiveFeed();
page.publish('a', Array.from({ length: 200 }, () => ({ type: 'text_delta', delta: 'x' })));
assert.equal(page.read('a').liveEvents.length, 128);
assert.equal(page.read('a', { afterCursor: 128 }).liveEvents.length, 72);
const burst = createSessionLiveFeed();
for (let n = 0; n < 609; n++) burst.publish('burst', [{ type: 'text_delta', runId: 'run-burst', canonicalMessageId: 'message-burst', delta: String(n % 10) }]);
let cursor = 0, delivered = 0;
while (delivered < 609) {
  const result = burst.read('burst', { afterCursor: cursor });
  assert.equal(result.liveResetRequired, false, 'A small 609-token response must survive a delayed first network read');
  assert.ok(result.liveEvents.length > 0 && result.liveEvents.length <= 128);
  delivered += result.liveEvents.length; cursor = result.liveCursor;
}
assert.equal(delivered, 609);
assert.ok(burst.stats().bytes <= 512 * 1024, 'The existing per-session byte limit remains authoritative');
console.log('test-session-live-feed: cursor/retry/repeated tokens/isolation/gap/size/capacity/TTL PASS');

// Real Codex v2 frames carry request/provider lineage, about 1.2KiB per token.
const lineageBurst = createSessionLiveFeed();
for (let n = 0; n < 1157; n++) lineageBurst.publish('lineage', [{
  type: 'text_delta', runId: 'run-lineage', canonicalMessageId: 'message-lineage',
  delta: String(n % 10), providerThreadId: 't'.repeat(128), providerTurnId: 'u'.repeat(128),
  providerItemId: 'i'.repeat(128), requestId: 'r'.repeat(128), harnessEventId: 'h'.repeat(128),
  providerEventId: 'p'.repeat(128), responseId: 's'.repeat(128),
}]);
let lineageCursor = 0;
while (lineageCursor < 1157) {
  const result = lineageBurst.read('lineage', { afterCursor: lineageCursor });
  assert.equal(result.liveResetRequired, false, 'Protocol lineage must not evict a short response before the first mobile read');
  assert.ok(result.liveEvents.length > 0);
  lineageCursor = result.liveCursor;
}
assert.ok(lineageBurst.stats().bytes <= 2 * 1024 * 1024);

const codexDelta = (ordinal, text = 'l', overrides = {}) => ({
  type: 'text_delta', canonicalMessageId: 'message-codex', runId: 'run-codex',
  text, providerEventId: `agent-message:item:${ordinal}`, id: `evt_${ordinal}`,
  timestamp: ordinal, ...overrides,
});
const compact = createSessionLiveFeed({ compactPendingDeltas: true });
for (let n = 1; n <= 1000; n++) compact.publish('codex', [codexDelta(n)]);
const compactFirst = compact.read('codex');
assert.equal(compactFirst.liveEvents.length, 1);
assert.equal(compactFirst.liveEvents[0].text, 'l'.repeat(1000), 'Repeated tokens are retained exactly');
assert.equal(compactFirst.liveCursor, 1000, 'Cursor still counts original frames');
compact.publish('codex', [codexDelta(1001), codexDelta(1002)]);
const retried = compact.read('codex');
assert.deepEqual(retried.liveEvents[0], compactFirst.liveEvents[0], 'Exposed batches never change after another publish');
const secondReader = compact.read('codex', { afterCursor: 1000 });
assert.equal(secondReader.liveEvents[0].text, 'll');
assert.equal(secondReader.liveCursor, 1002);
assert.equal(compact.read('codex', { afterCursor: 500 }).liveResetRequired, true, 'An interior cursor fails closed');
assert.equal(compact.read('codex', { afterCursor: 1001 }).liveResetRequired, true);
assert.deepEqual(compact.read('codex', { afterCursor: 1000 }), secondReader, 'Independent reader retry remains stable');
assert.ok(compact.stats().bytes < 4096, 'Pending lineage is not repeated for every token');
const spool = createSessionLiveFeed({ compactPendingDeltas: true });
spool.publish('a', [1, 2, 3].map(n => codexDelta(n, 'l', {
  harnessEventSource: 'spool-record', harnessEventId: `spool:record-${n}:0`, providerEventIndex: 0,
})));
assert.equal(spool.read('a').liveEvents[0].text, 'lll', 'Spool replay lineage does not prevent contiguous provider compaction');

for (const override of [
  { runId: 'other-run' }, { canonicalMessageId: 'other-message' }, { role: 'reasoning' },
  { providerEventId: 'agent-message:item:1' }, { providerEventId: 'agent-message:other:2' },
  { eventId: 'explicit-delivery' }, { textMode: 'snapshot' }, { harnessEventId: 'different-source' },
]) {
  const separate = createSessionLiveFeed({ compactPendingDeltas: true });
  separate.publish('a', [codexDelta(1), codexDelta(2, 'x', override)]);
  assert.equal(separate.read('a').liveEvents.length, 2, 'Identity boundaries must remain separate');
}
const capped = createSessionLiveFeed({ maximumSessionBytes: 400, compactPendingDeltas: true });
for (let n = 1; n <= 20; n++) capped.publish('a', [codexDelta(n, 'x'.repeat(40))]);
assert.ok(capped.stats().bytes <= 400, 'Compaction preserves the session byte budget');
assert.equal(capped.read('a').liveResetRequired, true, 'Eviction still reports a missing prefix');
console.log('test-session-live-feed: pending Codex compaction, immutable retries, multiple readers and budgets PASS');

const fullBatch = createSessionLiveFeed({ compactPendingDeltas: true });
const fullText = Array.from({length: 4096}, (_, n) => String(n % 10)).join('');
assert.equal(publishAllLiveEvents(fullBatch, 'batch', Array.from(fullText, (text, n) => codexDelta(n + 1, text))), true);
const fullPage = fullBatch.read('batch');
assert.equal(fullPage.liveResetRequired, false);
assert.equal(fullPage.liveCursor, 4096);
assert.equal(fullPage.liveEvents.map(e => e.text || '').join(''), fullText, 'A producer batch larger than 512 retains every real delta');
const legacyBatch = createSessionLiveFeed();
publishAllLiveEvents(legacyBatch, 'batch', Array.from({length: 609}, (_, n) => ({type:'text_delta', text:String(n%10)})));
let legacyCursor=0, legacyText='';
while(legacyCursor<609) {
 const p=legacyBatch.read('batch',{afterCursor:legacyCursor});
 assert.equal(p.liveResetRequired,false);
 legacyText+=p.liveEvents.map(e=>e.text).join('');legacyCursor=p.liveCursor;
}
assert.equal(legacyText.length,609,'Legacy delivery also retains a complete producer batch');
