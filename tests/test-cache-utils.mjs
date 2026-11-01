#!/usr/bin/env node
import assert from 'assert/strict';
import { BoundedLruMap } from '../chat/cache-utils.mjs';

// --- entry-cap eviction: oldest inserted first ---
const byEntries = new BoundedLruMap({ maxEntries: 3 });
byEntries.set('a', 1);
byEntries.set('b', 2);
byEntries.set('c', 3);
byEntries.set('d', 4);
assert.equal(byEntries.size, 3, 'entry cap evicts the oldest');
assert.equal(byEntries.has('a'), false, '"a" was the oldest and must be evicted');
assert.deepEqual([...byEntries.keys()], ['b', 'c', 'd'], 'eviction keeps insertion order of the survivors');

// --- LRU touch: get() moves an entry to the tail ---
byEntries.get('b');
byEntries.set('e', 5);
assert.equal(byEntries.has('c'), false, 'after touching "b", "c" becomes the oldest and must go');
assert.deepEqual([...byEntries.keys()], ['d', 'b', 'e'], 'touched entry survives one more eviction round');

// --- byte-cap eviction with bytesOf ---
const byBytes = new BoundedLruMap({ maxBytes: 12, bytesOf: (value) => value.length });
byBytes.set('a', 'xxxx'); // 4
byBytes.set('b', 'yyyy'); // 8 total
byBytes.set('c', 'zz');   // 10 total — fits
byBytes.set('d', 'qq');   // 12 total — fits
byBytes.set('e', 'wwww'); // would be 16 → evicts oldest until ≤ 12
assert.ok(byBytes.size <= 4, `byte cap evicts (size=${byBytes.size})`);
assert.ok(byBytes.byteSize <= 12, `byteSize tracks the cap (${byBytes.byteSize})`);
assert.equal(byBytes.has('a'), false, 'oldest evicted by byte pressure');

// --- set() on an existing key replaces and re-accounts bytes ---
byBytes.set('b', 'x'); // 4 → 1: byteSize must drop by 3
assert.equal(byBytes.byteSize, 9, 'replacing a key re-accounts its bytes');

// --- delete() re-accounts ---
byBytes.delete('b');
assert.equal(byBytes.byteSize, 8, 'delete removes the entry bytes');
assert.equal(byBytes.size, 3);

// --- deleteMatching removes all matching keys (clearSessionCaches prefix pattern) ---
const prefixed = new BoundedLruMap({ maxEntries: 100 });
prefixed.set('sess-1:5', 1);
prefixed.set('sess-1:6', 2);
prefixed.set('sess-2:1', 3);
prefixed.deleteMatching((key) => key.startsWith('sess-1:'));
assert.deepEqual([...prefixed.keys()], ['sess-2:1'], 'deleteMatching prunes by predicate');

// --- Map API compatibility ---
assert.equal(typeof prefixed.get('sess-2:1'), 'number');
assert.equal(prefixed.has('sess-2:1'), true);
prefixed.clear();
assert.equal(prefixed.size, 0);
assert.equal(prefixed.byteSize, 0, 'clear() resets byte accounting');

// --- no caps = plain Map behavior ---
const uncapped = new BoundedLruMap();
for (let i = 0; i < 1000; i += 1) uncapped.set(`k${i}`, i);
assert.equal(uncapped.size, 1000, 'unbounded instance never evicts');

// --- non-finite byte estimate is ignored, entry cap still bounds ---
const weird = new BoundedLruMap({ maxBytes: 10, bytesOf: () => NaN });
for (let i = 0; i < 50; i += 1) weird.set(`k${i}`, i);
assert.equal(weird.byteSize, 0, 'NaN estimates do not poison accounting');

console.log('test-cache-utils: ok');
