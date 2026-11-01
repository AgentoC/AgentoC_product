#!/usr/bin/env node
// DS-09 benchmark: per-session provider-event dedup structure comparison.
//
// The observer persists provider-identified events only once per dedup key
// (runId + type + providerId + identity fields + body). Structured runtimes
// (Claude/Codex) re-emit the SAME events across many spool lines while a
// message streams (accumulating snapshots), so a per-session "known keys"
// cache is what keeps the observer from reloading full history on every tick.
//
// Candidates (see plan card DS-09: "先写基准比较 Set、hash window、provider
// sequence"):
//   1. set-full      — status quo: exact full-key Set per session, hard cap
//                      (150k); on cap overflow the WHOLE set is dropped and
//                      the next tick pays a full-history rebuild (which then
//                      overflows again → permanent reload storm).
//   2. hash-window   — exact recent-key window (25k full keys) + bounded FIFO
//                      hash tail (150k × 53-bit hashes). Keys outside the
//                      window but inside the tail need history verification.
//   3. bloom-window  — exact recent-key window (25k full keys) + Bloom filter
//                      over the FULL key universe (fixed bits, no pruning).
//                      Bloom never false-negatives, so "not in bloom" proves
//                      the key was never seen (persist, no load); "in bloom
//                      but not in window" is ambiguous (re-emission of an old
//                      key, or a rare false positive) → exact verification.
//   4. provider-seq  — dedup by (runId, type, providerId) only, ignoring the
//                      body. Demonstrated for the record: it collapses
//                      legitimate body-update snapshots (same provider id,
//                      accumulating tool input), which the current key
//                      semantics deliberately keep as distinct durable events.
//
// Metric per structure: decisions against the exact ground truth (lost =
// distinct durable event wrongly dropped; dup = re-emission wrongly persisted
// again), history-load cost (count + summed history sizes — the thing the
// cache exists to avoid), peak estimated bytes, real heap delta at 150k keys
// (needs `node --expose-gc` for a clean measurement; degrades gracefully
// without it), and classify throughput on a mixed batch.
//
// Usage: node --expose-gc scripts/benchmark-provider-dedup.mjs
import { getProviderEventDedupKey } from '../chat/provider-event-dedup.mjs';

// ---------------------------------------------------------------------------
// Deterministic PRNG + synthetic stream (Claude stream-json style)
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'check', 'report', 'list', 'find', 'parse', 'merge', 'fetch', 'build',
  'write', 'read', 'move', 'copy', 'tail', 'grep', 'sort', 'index',
  'validate', 'normalize', 'retry', 'cache', 'flush', 'spool', 'session',
  'provider', 'message', 'event', 'body', 'delta', 'offset', 'seq',
];

function makeText(rand, maxLen) {
  const n = 4 + Math.floor(rand() * 6);
  const words = [];
  for (let i = 0; i < n; i += 1) {
    words.push(WORDS[Math.floor(rand() * WORDS.length)]);
  }
  let text = words.join(' ');
  while (text.length < maxLen) {
    text += ` ${words[Math.floor(rand() * words.length)]}`;
  }
  return text.slice(0, maxLen);
}

// One group = one assistant message streaming k parallel tool_uses; every line
// re-emits the accumulated snapshot (all tool_uses so far) — the exact pattern
// Claude Code stream-json produces. Tool results + the final message re-emit
// once or twice more. tool_use bodies accumulate between snapshots (distinct
// durable events by current key semantics).
function generateStream({ runs = 2, uniquePerRun = 45000, minTools = 4, maxTools = 18, bigRatio = 0.02, seed = 20260807 } = {}) {
  const rand = mulberry32(seed);
  const lines = []; // each line: array of candidate events (normalized shape)
  let runSeq = 0;
  let globalKeySeq = 0;
  for (let run = 0; run < runs; run += 1) {
    runSeq += 1;
    const runId = `run-${runSeq}`;
    let made = 0;
    while (made < uniquePerRun) {
      const tools = minTools + Math.floor(rand() * (maxTools - minTools + 1));
      const msgId = `msg_${runSeq}_${made}`;
      const toolEvents = [];
      const snapshotLine = [];
      const reasoningLine = [
        { type: 'reasoning', role: 'assistant', runId, providerMessageId: msgId, content: `thinking ${makeText(rand, 120)}` },
      ];
      lines.push(reasoningLine);
      for (let t = 0; t < tools && made < uniquePerRun; t += 1) {
        made += 1;
        const toolUseId = `toolu_${runSeq}_${made}`;
        const toolName = t % 2 === 0 ? 'Bash' : 'Read';
        const big = rand() < bigRatio;
        const bodyLen = big ? 1500 + Math.floor(rand() * 6000) : 20 + Math.floor(rand() * 300);
        const toolInput = JSON.stringify({ command: makeText(rand, bodyLen) });
        const base = { type: 'tool_use', role: 'assistant', runId, providerToolUseId: toolUseId, toolName, toolInput };
        // Snapshot lines so far: every line re-emits all earlier tool_uses of
        // this message, and the current one accumulates (a later, longer body
        // = a distinct durable event under current key semantics).
        toolEvents.push(base);
        const snapshot = toolEvents.map((ev) => ({ ...ev }));
        if (t === tools - 1) {
          // The last snapshot re-appears on the next line too (final copy);
          // a random subset of tools carries a longer final body — a distinct
          // durable event by current key semantics (body-update snapshot),
          // which provider-sequence dedup would wrongly collapse.
          const finalSnapshot = toolEvents.map((ev, evIdx) => (
            rand() < 0.15
              ? { ...ev, toolInput: `${ev.toolInput}${'x'.repeat(40)}` }
              : { ...ev }
          ));
          snapshotLine.push(...toolEvents);
          lines.push(snapshotLine);
          lines.push(finalSnapshot);
        } else {
          lines.push(snapshot);
        }
      }
      // Tool results, emitted once per tool (no re-emission).
      const resultsLine = toolEvents.map((ev, idx) => ({
        type: 'tool_result',
        runId,
        providerToolUseId: ev.providerToolUseId,
        exitCode: 0,
        output: makeText(rand, 60 + Math.floor(rand() * 200)),
        ...(idx % 5 === 0 ? { filePath: `/tmp/f${idx}.txt`, changeType: 'edit', added: 1, removed: 0 } : {}),
      }));
      lines.push(resultsLine);
      // Final assistant message, emitted twice (identical) to exercise message
      // re-emission dedup.
      const finalMessage = { type: 'message', role: 'assistant', runId, providerMessageId: `${msgId}_final`, content: `Done: ${makeText(rand, 60)}` };
      lines.push([finalMessage]);
      lines.push([{ ...finalMessage }]);
      globalKeySeq += tools + 2; // reasoning + final message + tool_uses + results
    }
  }
  const events = lines.flat();
  // Key size distribution summary for the report.
  let totalKeyBytes = 0;
  const sizes = [];
  for (const ev of events) {
    const key = getProviderEventDedupKey(ev);
    if (!key) continue;
    totalKeyBytes += key.length;
    sizes.push(key.length);
  }
  sizes.sort((a, b) => a - b);
  const pct = (p) => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))];
  return {
    events,
    stats: {
      lines: lines.length,
      events: events.length,
      uniqueKeys: new Set(events.map((e) => getProviderEventDedupKey(e)).filter(Boolean)).size,
      avgKeyBytes: Math.round(totalKeyBytes / sizes.length),
      p50KeyBytes: pct(0.5),
      p99KeyBytes: pct(0.99),
      maxKeyBytes: pct(1),
    },
  };
}

function chunkTicks(events, tickSize = 40) {
  const ticks = [];
  for (let i = 0; i < events.length; i += tickSize) {
    ticks.push(events.slice(i, i + tickSize));
  }
  return ticks;
}

// ---------------------------------------------------------------------------
// 53-bit stable hash (two-pass FNV-1a over char codes, combined to 53 bits;
// Math.imul keeps it allocation-free and fast) + Bloom filter. Identical
// primitives ship in chat/provider-event-dedup.mjs; the benchmark uses local
// copies so the measured reference does not depend on the shipped
// implementation.
// ---------------------------------------------------------------------------
function hashString53(text, seed = 0) {
  const str = String(text);
  let h1 = (0x811c9dc5 ^ seed) >>> 0;
  let h2 = (0x01000193 ^ Math.imul(seed, 0x9e3779b1)) >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x0100019b);
  }
  // h1 (32 bits) shifted left 21 + lower 21 bits of h2 → full 53-bit range.
  return (h1 >>> 0) * 2097152 + ((h2 >>> 0) & 0x1fffff);
}

function createBloom({ expectedKeys, falsePositiveRate = 1e-5 }) {
  const n = Math.max(1, Math.floor(expectedKeys));
  const p = Math.max(1e-12, Math.min(0.5, falsePositiveRate));
  const m = Math.max(64, Math.ceil((-n * Math.log(p)) / (Math.LN2 * Math.LN2)));
  const k = Math.max(1, Math.min(32, Math.round((m / n) * Math.LN2)));
  const bits = new Uint8Array(Math.ceil(m / 8));
  const mask = (bits.length * 8) - 1;
  return {
    m,
    k,
    bits,
    set(key) {
      const a = hashString53(key, 0x9e3779b97f4a7c15);
      const b = hashString53(key, 0xc2b2ae3d27d4eb4f) || 1;
      for (let i = 0; i < k; i += 1) {
        const idx = (a + i * b) & mask;
        bits[idx >> 3] |= 1 << (idx & 7);
      }
    },
    possiblyContains(key) {
      const a = hashString53(key, 0x9e3779b97f4a7c15);
      const b = hashString53(key, 0xc2b2ae3d27d4eb4f) || 1;
      for (let i = 0; i < k; i += 1) {
        const idx = (a + i * b) & mask;
        if ((bits[idx >> 3] & (1 << (idx & 7))) === 0) return false;
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Candidate structures
// ---------------------------------------------------------------------------
const EST_PER_ENTRY = 64; // V8 Set/Map entry overhead estimate (bytes)

// 1. Status quo: exact full-key Set, 150k cap → whole-set drop → reload.
// The reload is modeled symbolically: `live` aliases the sim's persisted-key
// set (a real rebuild from history has exactly that content), so the sim
// measures the *load cost* (counted per tick by the runner) without paying
// the quadratic rebuild itself.
class SetFull {
  constructor({ cap = 150000 } = {}) {
    this.cap = cap;
    this.live = new Set();
    this.dropped = false;
  }
  needsReload() {
    return this.dropped;
  }
  // Returns 'persist' | 'drop'
  classify(key) {
    if (this.dropped) return 'reload-needed';
    return this.live.has(key) ? 'drop' : 'persist';
  }
  add(key) {
    if (this.dropped) return;
    if (this.live.size >= this.cap) {
      this.dropped = true; // next tick pays one full-history reload
      return;
    }
    this.live.add(key);
  }
  reloadFrom(persistedKeys) { // full-history rebuild (the cost the cache avoids)
    this.live = persistedKeys;
    this.dropped = false;
  }
  estimateBytes() {
    return this.dropped ? 0 : this.live.size * (EST_PER_ENTRY + 24);
  }
}

// 2. Exact recent window + bounded FIFO hash tail.
class HashWindow {
  constructor({ recentCap = 25000, tailCap = 150000 } = {}) {
    this.recentCap = recentCap;
    this.tailCap = tailCap;
    this.recent = new Map(); // key -> true, insertion order
    this.tail = new Map(); // hash -> true, insertion order
    this.verifies = 0;
  }
  classify(key) {
    if (this.recent.has(key)) return 'drop';
    const hash = hashString53(key, 0x243f6a8885a308d3);
    if (this.tail.has(hash)) {
      this.verifies += 1;
      return 'verify';
    }
    return 'persist';
  }
  add(key) {
    this.recent.set(key, true);
    if (this.recent.size > this.recentCap) {
      this.recent.delete(this.recent.keys().next().value);
    }
    const hash = hashString53(key, 0x243f6a8885a308d3);
    this.tail.set(hash, true);
    if (this.tail.size > this.tailCap) {
      this.tail.delete(this.tail.keys().next().value);
    }
  }
  estimateBytes() {
    return this.recent.size * (EST_PER_ENTRY + 24) + this.tail.size * EST_PER_ENTRY;
  }
}

// 3. Exact recent window + Bloom filter over the FULL universe.
class BloomWindow {
  constructor({ recentCap = 25000, expectedKeys = 150000, falsePositiveRate = 1e-5 } = {}) {
    this.recentCap = recentCap;
    this.recent = new Map(); // key -> true, insertion order
    this.bloom = createBloom({ expectedKeys, falsePositiveRate });
    this.verifies = 0;
  }
  classify(key) {
    if (this.recent.has(key)) return 'drop';
    if (this.bloom.possiblyContains(key)) {
      this.verifies += 1;
      return 'verify';
    }
    return 'persist';
  }
  add(key) {
    this.recent.set(key, true);
    if (this.recent.size > this.recentCap) {
      this.recent.delete(this.recent.keys().next().value);
    }
    this.bloom.set(key);
  }
  estimateBytes() {
    return this.recent.size * (EST_PER_ENTRY + 24) + this.bloom.bits.length;
  }
}

// 4. Provider-sequence dedup: (runId, type, providerId) only, body ignored.
class ProviderSeq {
  constructor({ cap = 150000 } = {}) {
    this.cap = cap;
    this.seen = new Map(); // identity -> true, insertion order
  }
  identityOf(key) {
    // key = JSON.stringify([runId, type, id..., body]) → strip the trailing
    // body element (the last array element is always the body for the
    // provider-identified event types).
    try {
      const parts = JSON.parse(key);
      return parts.slice(0, -1).join('');
    } catch {
      return key;
    }
  }
  classify(key) {
    return this.seen.has(this.identityOf(key)) ? 'drop' : 'persist';
  }
  add(key) {
    const id = this.identityOf(key);
    if (!this.seen.has(id)) {
      this.seen.set(id, true);
    }
    if (this.seen.size > this.cap) {
      this.seen.delete(this.seen.keys().next().value);
    }
  }
  estimateBytes() {
    return this.seen.size * (EST_PER_ENTRY + 24);
  }
}

// ---------------------------------------------------------------------------
// Simulation: one session lifecycle, per structure. Ticks are pre-keyed
// (dedup keys computed once up front) so the comparison measures the
// structures, not key stringification.
// ---------------------------------------------------------------------------
function simulate(ticks, makeStructure, { name, family = null }) {
  const structure = makeStructure();
  const persistedKeys = new Set(); // ground truth: exact keys persisted
  const history = []; // insertion order, for reload simulation
  let loads = 0;
  let loadWork = 0; // Σ history size at each load (real cost of the cache miss)
  let dups = 0; // candidates wrongly persisted although already persisted
  let lost = 0; // distinct ground-truth keys never persisted
  const seenKeys = new Set(); // all distinct keys that should persist

  for (const tick of ticks) {
    const verified = [];
    if (typeof structure.needsReload === 'function' && structure.needsReload()) {
      // The set was dropped at its cap; this tick pays one full-history
      // rebuild, after which the verdict is exact again.
      loads += 1;
      loadWork += history.length;
      structure.reloadFrom(persistedKeys);
    }
    for (const key of tick) {
      if (!key) continue; // no provider identity → always passes through
      if (!seenKeys.has(key)) seenKeys.add(key);
      const verdict = structure.classify(key);
      if (verdict === 'drop') continue;
      if (verdict === 'reload-needed') continue; // reloaded above
      if (verdict === 'verify') {
        verified.push(key);
        continue;
      }
      // persist
      if (persistedKeys.has(key)) dups += 1;
      persistedKeys.add(key);
      history.push(key);
      structure.add(key);
    }
    if (verified.length > 0) {
      // Exact verification against persisted history: one load for the batch.
      loads += 1;
      loadWork += history.length;
      const toPersist = verified.filter((key) => !persistedKeys.has(key));
      for (const key of toPersist) {
        persistedKeys.add(key);
        history.push(key);
        structure.add(key);
      }
      dups += verified.length - toPersist.length;
    }
  }
  for (const key of seenKeys) {
    if (!persistedKeys.has(key)) lost += 1;
  }
  return {
    name,
    family,
    loads,
    loadWork,
    dups,
    lost,
    endBytes: Math.max(structure.estimateBytes(), 1),
    finalKeyCount: persistedKeys.size,
    verifyCount: structure.verifies || 0,
  };
}

// ---------------------------------------------------------------------------
// Real heap probe at 150k keys + throughput
// ---------------------------------------------------------------------------
function measureHeapDelta(fn) {
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  const result = fn();
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const after = process.memoryUsage().heapUsed;
  return { heapDelta: Math.max(0, after - before), result };
}

function throughputProbe() {
  const rand = mulberry32(7);
  const keys = [];
  for (let i = 0; i < 20000; i += 1) {
    const body = makeText(rand, 40 + Math.floor(rand() * 200));
    keys.push(JSON.stringify([`run-${i % 50}`, 'tool_use', `toolu_${i}`, 'Bash', body]));
  }
  const candidates = [];
  for (let i = 0; i < 500000; i += 1) {
    // 90% re-emission of a recent key, 10% new key.
    const key = rand() < 0.9 ? keys[Math.floor(rand() * 500)] : `new-${i}`;
    candidates.push(key);
  }
  const structures = [
    ['set-full', () => new SetFull()],
    ['hash-window', () => new HashWindow()],
    ['bloom-window', () => new BloomWindow()],
    ['provider-seq', () => new ProviderSeq()],
  ];
  const out = [];
  for (const [name, make] of structures) {
    const structure = make();
    for (const key of keys) structure.add(key);
    const start = process.hrtime.bigint();
    for (const key of candidates) structure.classify(key);
    const ns = Number(process.hrtime.bigint() - start);
    out.push({ name, classifyOpsPerSec: Math.round(candidates.length / (ns / 1e9)) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const BENCH_START = Date.now();
const benchLog = (label) => console.log(`  [${Math.round((Date.now() - BENCH_START) / 100) / 10}s] ${label}`);

// Pre-key every event once; all structure comparisons reuse the keyed ticks.
const stream = generateStream();
const keyedEvents = stream.events
  .map((event) => getProviderEventDedupKey(event))
  .filter(Boolean);
const ticks = chunkTicks(keyedEvents);

console.log('DS-09 dedup structure benchmark');
console.log('------------------------------------------------------------------');
console.log('Stream:');
for (const [label, value] of Object.entries(stream.stats)) {
  console.log(`  ${label}: ${value}`);
}

const families = [
  ['set-full', 'set-full (status quo)', () => new SetFull()],
  ['hash-window', 'hash-window', () => new HashWindow()],
  ['bloom-window', 'bloom-window', () => new BloomWindow()],
  ['provider-seq', 'provider-seq', () => new ProviderSeq()],
];
benchLog('stream + ticks ready');
const results = families.map(([family, name, make]) => simulate(ticks, make, { name, family }));
benchLog('lifecycle sims done');

// Ancient re-emission stress: re-emit the very first keyed event after the
// whole stream — the case that separates hash-window (FIFO tail forgets) from
// bloom-window (full universe, never forgets).
{
  const firstKey = keyedEvents[0];
  const stressTicks = [...ticks, [firstKey]];
  benchLog('stress sims starting');
  for (const [family, , make] of families) {
    const withStress = simulate(stressTicks, make, { name: family, family });
    const base = results.find((r) => r.family === family);
    const stressDup = withStress.dups - base.dups;
    const stressLoads = withStress.loads - base.loads;
    console.log(`  ancient re-emission (${family}): ${stressDup > 0 ? `${stressDup} DUPLICATE persisted` : 'correctly dropped'}${stressLoads > 0 ? ` (+${stressLoads} history load)` : ''}`);
  }
}

console.log('------------------------------------------------------------------');
console.log('Lifecycle simulation (one session, exact ground truth):');
console.log('  name                 loads  loadWork   dups  lost  endEstKB');
for (const r of results) {
  console.log(`  ${r.name.padEnd(24)} ${String(r.loads).padStart(5)} ${String(r.loadWork).padStart(10)} ${String(r.dups).padStart(5)} ${String(r.lost).padStart(5)} ${String(Math.round(r.endBytes / 1024)).padStart(9)}`);
}
console.log('  loadWork = Σ persisted-history sizes at each load (the cost the');
console.log('  cache exists to avoid; 0 = never reloaded history).');

console.log('------------------------------------------------------------------');
console.log('Real heap delta at 150k keys (--expose-gc for clean measurement):');
const rand = mulberry32(99);
const keyPool = [];
for (let i = 0; i < 150000; i += 1) {
  keyPool.push(JSON.stringify([`run-${i % 40}`, 'tool_use', `toolu_${i}`, 'Bash', makeText(rand, 80 + Math.floor(rand() * 400))]));
}
benchLog('stress sims done');
const sharedDelta = measureHeapDelta(() => {
  for (let i = 0; i < 150000; i += 1) {
    keyPool.push(JSON.stringify([`run-${i % 40}`, 'tool_use', `toolu_${i}`, 'Bash', makeText(rand, 80 + Math.floor(rand() * 400))]));
  }
});
console.log(`  shared key strings heap delta: ${Math.round(sharedDelta.heapDelta / 1024)} KB (all four share this)`);
const heapProbe = {};
for (const [name, make] of [['set-full', () => new SetFull()], ['hash-window', () => new HashWindow()], ['bloom-window', () => new BloomWindow()], ['provider-seq', () => new ProviderSeq()]]) {
  const { heapDelta, result } = measureHeapDelta(() => {
    const structure = make();
    for (const key of keyPool) structure.add(key);
    return structure.estimateBytes();
  });
  heapProbe[name] = { estKB: Math.round(result / 1024), realKB: Math.round(heapDelta / 1024) };
  console.log(`  ${name.padEnd(14)} est ${String(heapProbe[name].estKB).padStart(6)} KB  real ${String(heapProbe[name].realKB).padStart(6)} KB`);
}

console.log('------------------------------------------------------------------');
console.log('Throughput (500k classify ops, 90% re-emission / 10% new):');
for (const probe of throughputProbe()) {
  console.log(`  ${probe.name.padEnd(14)} ${String(probe.classifyOpsPerSec).padStart(12)} ops/sec`);
}
