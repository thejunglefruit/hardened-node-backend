// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// In-memory cache: LRU with expiry (TTL), stampede protection (if 100 requests ask for the same missing value at once,
// only one computes it; the others wait for that result) and invalidation by tag or by key.
export function createCache({ max = 500, ttlMs = 60000, now = Date.now } = {}) {
  const map = new Map();            // key → { value, expires, tags }  (Map order is LRU order)
  const inFlight = new Map();       // key → Promise
  const stats = { hits: 0, misses: 0, evicted: 0 };

  function read(key) {
    const e = map.get(key);
    if (!e) return undefined;
    if (e.expires <= now()) { map.delete(key); return undefined; }
    map.delete(key); map.set(key, e);  // the recent one moves to the end
    return e;
  }
  function put(key, value, { ttl = ttlMs, tags = [] } = {}) {
    map.delete(key);
    map.set(key, { value, expires: now() + ttl, tags: new Set(tags) });
    while (map.size > max) { map.delete(map.keys().next().value); stats.evicted++; }
  }

  return {
    get(key) { const e = read(key); e ? stats.hits++ : stats.misses++; return e?.value; },
    set: put,
    /** Returns the stored value or computes it ONCE even if many ask at the same time. Errors are not cached. */
    async getOrSet(key, compute, options) {
      const e = read(key);
      if (e) { stats.hits++; return e.value; }
      if (inFlight.has(key)) return inFlight.get(key);
      stats.misses++;
      const p = Promise.resolve().then(compute).then((v) => { put(key, v, options); return v; }).finally(() => inFlight.delete(key));
      inFlight.set(key, p);
      return p;
    },
    delete(key) { return map.delete(key); },
    /** Invalidates everything marked with that tag (e.g. 'user:7' when the user changes). */
    invalidateTag(tag) { let n = 0; for (const [k, e] of map) if (e.tags.has(tag)) { map.delete(k); n++; } return n; },
    clear() { map.clear(); },
    get size() { return map.size; },
    get stats() { return { ...stats, size: map.size }; },
  };
}
