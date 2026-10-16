// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// In-memory rate limits, no dependencies.
//   createRateLimiter: a token bucket per key (usually the IP): `capacity` requests at once, then `perSecond`.
//   createFailureCounter: counts failed attempts (bad API key, bad login) per key and blocks it for a while.
// Both tables evict their oldest entries so an attacker cannot fill memory with millions of IPs.

function createTable(maxKeys) {
  const table = new Map();
  const makeRoom = () => {
    if (table.size < maxKeys) return;
    // drop the oldest 10 % (a Map keeps insertion order)
    let n = Math.ceil(maxKeys / 10);
    for (const k of table.keys()) { table.delete(k); if (--n <= 0) break; }
  };
  return { table, makeRoom };
}

export function createRateLimiter({ capacity = 60, perSecond = 1, maxKeys = 50000, now = Date.now } = {}) {
  const { table, makeRoom } = createTable(maxKeys);
  return {
    /** Returns { ok, retryAfter } (seconds) and spends a token if there is one. */
    allow(key) {
      const t = now();
      let b = table.get(key);
      if (!b) { makeRoom(); b = { tokens: capacity, last: t }; table.set(key, b); }
      b.tokens = Math.min(capacity, b.tokens + ((t - b.last) / 1000) * perSecond);
      b.last = t;
      if (b.tokens >= 1) { b.tokens -= 1; return { ok: true, retryAfter: 0 }; }
      return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / perSecond) };
    },
    forget(key) { table.delete(key); },
    get size() { return table.size; },
  };
}

export function createFailureCounter({ maxFailures = 20, windowMs = 10 * 60 * 1000, blockMs = 15 * 60 * 1000, maxKeys = 50000, now = Date.now } = {}) {
  const { table, makeRoom } = createTable(maxKeys);
  return {
    /** Is this key blocked? Returns the seconds left, or 0. */
    blocked(key) {
      const c = table.get(key);
      if (!c) return 0;
      if (c.until && c.until > now()) return Math.ceil((c.until - now()) / 1000);
      if (c.until) table.delete(key);
      return 0;
    },
    /** Records a failure. Returns true if this failure blocks the key. */
    fail(key) {
      const t = now();
      let c = table.get(key);
      if (!c || t - c.since > windowMs) { makeRoom(); c = { since: t, n: 0, until: 0 }; table.set(key, c); }
      c.n += 1;
      if (c.n >= maxFailures) { c.until = t + blockMs; return true; }
      return false;
    },
    success(key) { table.delete(key); },
    get size() { return table.size; },
  };
}
