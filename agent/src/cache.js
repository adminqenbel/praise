// Bounded decision cache (LRU + per-entry TTL, count and byte limits) and an in-flight request coalescer.
// Entries hold a pre-serialised JSON head so a hit costs one Map lookup and one string concatenation: no JSON.stringify on the hot path.
"use strict";

class TtlLruCache {
  // hashKey(key) -> short stable string; used only to match entries loaded from disk (the file never holds raw URLs).
  constructor({ maxEntries = 10000, maxBytes = 16 * 1024 * 1024, now = Date.now, hashKey = null } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.now = now;
    this.hashKey = hashKey;
    this.map = new Map();      // insertion order = recency order
    this.bytes = 0;
    this.warm = new Map();     // hashedKey -> row from disk, promoted into `map` on first use
    this.hits = 0; this.misses = 0; this.evictions = 0;
  }

  get size() { return this.map.size; }

  get(key) {
    const e = this.map.get(key);
    if (e !== undefined) {
      if (e.exp > this.now()) {
        this.map.delete(key); this.map.set(key, e);      // refresh recency
        this.hits++;
        return e;
      }
      this._drop(key, e);
    } else if (this.warm.size && this.hashKey) {
      const h = this.hashKey(key);
      const w = this.warm.get(h);
      if (w) {
        this.warm.delete(h);
        if (w.exp > this.now()) { this.set(key, w, w.exp - this.now()); this.hits++; return w; }
      }
    }
    this.misses++;
    return undefined;
  }

  // entry: { status, head, neg? }. ttlMs <= 0 means "do not cache".
  set(key, entry, ttlMs) {
    if (!(ttlMs > 0)) return entry;
    const old = this.map.get(key);
    if (old !== undefined) this._drop(key, old);
    entry.exp = this.now() + ttlMs;
    entry.size = key.length * 2 + entry.head.length * 2 + 96;
    this.map.set(key, entry);
    this.bytes += entry.size;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this._drop(oldest.value, this.map.get(oldest.value));
      this.evictions++;
    }
    return entry;
  }

  _drop(key, e) { this.map.delete(key); this.bytes -= e.size; }

  clear() { this.map.clear(); this.warm.clear(); this.bytes = 0; }

  // Rows for the persistence file: only positive, still-fresh entries with at least `minLifeMs` left, newest last, at most `limit`.
  dump(limit = 2000, minLifeMs = 60000) {
    if (!this.hashKey) return [];
    const t = this.now();
    const rows = [];
    for (const [key, e] of this.map) {
      if (e.neg || e.status !== 200 || e.exp - t < minLifeMs) continue;
      rows.push([this.hashKey(key), e.status, e.head, e.exp]);
    }
    return rows.slice(-limit);
  }

  loadWarm(rows) {
    for (const r of rows) this.warm.set(r[0], { status: r[1], head: r[2], exp: r[3], size: 0 });
  }
}

// If an identical lookup is already running, share its promise instead of starting another. Synchronous work never registers.
class Coalescer {
  constructor() { this.inflight = new Map(); this.shared = 0; }
  run(key, fn) {
    const running = this.inflight.get(key);
    if (running) { this.shared++; return running; }
    const out = fn();
    if (out && typeof out.then === "function") {
      const p = out.then((v) => { this.inflight.delete(key); return v; }, (e) => { this.inflight.delete(key); throw e; });
      this.inflight.set(key, p);
      return p;
    }
    return out;
  }
  get pending() { return this.inflight.size; }
}

module.exports = { TtlLruCache, Coalescer };
