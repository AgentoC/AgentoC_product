/**
 * Bounded LRU map for read-through caches.
 *
 * Every cache here sits in front of data that is also persisted on disk, so
 * eviction is always safe: a miss re-reads the file. The cap bounds the
 * in-memory footprint of hot sessions/runs/events instead of retaining every
 * entry ever touched for the life of the process (which is what previously
 * let RSS grow to several hundred MB).
 *
 * Extends Map so existing call sites (has/get/set/delete/clear/iteration)
 * work unchanged. `get` re-inserts the entry at the tail (LRU touch); `set`
 * evicts oldest entries while either cap is exceeded. Byte accounting is
 * best-effort: if `bytesOf` under-counts, the entry cap still bounds growth.
 *
 * `ttlMs` (DS-08) makes entries past their insertion age expire: a stale `get`
 * is treated as a miss (evicted + counted), and expired entries are swept
 * before cap enforcement so they never linger past the TTL. `onEvict(key,
 * value)` fires on eviction paths only (overflow + TTL expiry) — application-
 * initiated `delete()` calls keep their own cleanup so the meta maps of DS-08
 * stay in lockstep without double-removal churn.
 */
function estimateBytes(fn, value, key) {
  try {
    const count = fn(value, key);
    return Number.isFinite(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

export class BoundedLruMap extends Map {
  constructor({
    maxEntries = Infinity,
    maxBytes = Infinity,
    bytesOf = null,
    ttlMs = null,
    onEvict = null,
  } = {}) {
    super();
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.bytesOf = typeof bytesOf === 'function' ? bytesOf : null;
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : null;
    this.onEvict = typeof onEvict === 'function' ? onEvict : null;
    this.byteSize = 0;
    // Observability counters (DS-06): consumed by the memory registry sampler
    // and /healthz. Hit/miss/eviction counters are monotonic; age is derived
    // from per-entry insertion timestamps.
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.createdAtMs = Date.now();
    this.entryCreatedMs = new Map();
    // Interval-gated expiry sweep: full sweeps run at most once per ttlMs, so
    // set() stays amortized O(1) even for caches with large entry caps.
    this._nextExpiryCheckMs = this.ttlMs ? Date.now() + this.ttlMs : null;
  }

  _isExpired(key, now = Date.now()) {
    if (!this.ttlMs) return false;
    const created = this.entryCreatedMs.get(key);
    return created != null && now - created > this.ttlMs;
  }

  get(key) {
    if (!super.has(key)) {
      this.misses += 1;
      return undefined;
    }
    if (this._isExpired(key)) {
      const value = super.get(key);
      this.delete(key);
      this.evictions += 1;
      this.onEvict?.(key, value);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    const value = super.get(key);
    super.delete(key);
    super.set(key, value);
    return value;
  }

  set(key, value) {
    if (super.has(key)) {
      if (this.bytesOf) this.byteSize -= estimateBytes(this.bytesOf, super.get(key), key);
      super.delete(key);
    }
    super.set(key, value);
    this.entryCreatedMs.set(key, Date.now());
    if (this.bytesOf) this.byteSize += estimateBytes(this.bytesOf, value, key);
    this.evictOverflow();
    return this;
  }

  delete(key) {
    if (super.has(key) && this.bytesOf) {
      this.byteSize -= estimateBytes(this.bytesOf, super.get(key), key);
    }
    this.entryCreatedMs.delete(key);
    return super.delete(key);
  }

  clear() {
    super.clear();
    this.byteSize = 0;
    this.entryCreatedMs.clear();
  }

  deleteMatching(predicate) {
    for (const key of [...super.keys()]) {
      if (predicate(key)) this.delete(key);
    }
  }

  /**
   * Remove entries past their TTL. Runs at most once per ttlMs interval (see
   * _nextExpiryCheckMs); per-key staleness is also handled lazily in `get`.
   */
  evictExpired(now = Date.now()) {
    if (!this.ttlMs || !this.entryCreatedMs.size) {
      this._nextExpiryCheckMs = null;
      return;
    }
    if (this._nextExpiryCheckMs != null && now < this._nextExpiryCheckMs) return;
    // Deleting the current entry while iterating a Map is safe; expired
    // entries are removed before cap enforcement so they never count toward
    // the caps.
    for (const [key, createdMs] of this.entryCreatedMs) {
      if (now - createdMs > this.ttlMs) {
        const value = super.get(key);
        this.delete(key);
        this.evictions += 1;
        this.onEvict?.(key, value);
      }
    }
    this._nextExpiryCheckMs = this.entryCreatedMs.size ? now + this.ttlMs : null;
  }

  evictOverflow() {
    this.evictExpired();
    while ((Number.isFinite(this.maxEntries) && this.size > this.maxEntries)
      || (Number.isFinite(this.maxBytes) && this.byteSize > this.maxBytes)) {
      const oldest = super.keys().next().value;
      if (oldest === undefined) break;
      const value = super.get(oldest);
      this.delete(oldest);
      this.evictions += 1;
      this.onEvict?.(oldest, value);
    }
  }

  /**
   * JSON-safe observability snapshot (DS-06). O(size) scan for the oldest
   * insertion — cheap at the sampler cadence (60s) and diagnostic rate.
   */
  snapshotMetrics(now = Date.now()) {
    let oldestInsertMs = null;
    for (const insertedMs of this.entryCreatedMs.values()) {
      if (oldestInsertMs == null || insertedMs < oldestInsertMs) oldestInsertMs = insertedMs;
    }
    const lookups = this.hits + this.misses;
    return {
      entries: this.size,
      bytes: this.byteSize,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: lookups > 0 ? Math.round((this.hits / lookups) * 10000) / 10000 : null,
      oldestEntryAgeMs: oldestInsertMs == null ? null : Math.max(0, now - oldestInsertMs),
      maxEntries: Number.isFinite(this.maxEntries) ? this.maxEntries : null,
      maxBytes: Number.isFinite(this.maxBytes) ? this.maxBytes : null,
      ttlMs: this.ttlMs,
    };
  }
}
