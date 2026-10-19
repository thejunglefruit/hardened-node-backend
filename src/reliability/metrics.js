// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// Dependency-free metrics: counters, gauges and histograms, Prometheus text output, percentiles (p50/p95/p99 per
// route over a sliding window) and SLO / error-budget calculation.
// Hook it up with `measure(res, route)`: when the response closes it records status and duration.
const LABELS = (e) => Object.entries(e).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}="${String(v).replace(/[\\"\n]/g, '_')}"`).join(',');

export function createMetrics({ windowMs = 3600000, maxSamples = 5000, now = Date.now, buckets = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] } = {}) {
  const counters = new Map();  // 'name{labels}' → number
  const gauges = new Map();
  const histos = new Map();    // 'name{labels}' → { counts[], sum, n }
  const samples = new Map();   // route → [{ t, ms, ok }]  (sliding window for percentiles and SLO)

  const key = (name, labels = {}) => `${name}{${LABELS(labels)}}`;

  function count(name, labels = {}, n = 1) { const k = key(name, labels); counters.set(k, (counters.get(k) || 0) + n); }
  function gauge(name, value, labels = {}) { gauges.set(key(name, labels), value); }
  function observe(name, seconds, labels = {}) {
    const k = key(name, labels);
    let h = histos.get(k);
    if (!h) { h = { counts: new Array(buckets.length + 1).fill(0), sum: 0, n: 0 }; histos.set(k, h); }
    let i = buckets.findIndex((c) => seconds <= c); if (i < 0) i = buckets.length;
    h.counts[i]++; h.sum += seconds; h.n++;
  }

  /** Exact percentile over the window's samples (nearest-rank method). */
  function percentile(values, p) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
  }

  function record(route, status, ms) {
    const ok = status < 500;
    count('http_requests_total', { route, class: `${Math.floor(status / 100)}xx` });
    observe('http_duration_seconds', ms / 1000, { route });
    let a = samples.get(route); if (!a) { a = []; samples.set(route, a); }
    a.push({ t: now(), ms, ok });
    if (a.length > maxSamples) a.splice(0, a.length - maxSamples);
  }

  /** Call at the start of each request; when the response closes it records status and duration. Normalise the route (no ids in labels). */
  function measure(res, route) {
    const t0 = process.hrtime.bigint();
    res.once('close', () => record(route, res.statusCode, Number(process.hrtime.bigint() - t0) / 1e6));
  }

  function windowOf(route) {
    const since = now() - windowMs;
    return (route ? [samples.get(route) || []] : [...samples.values()]).flat().filter((m) => m.t >= since);
  }

  /** Latencies of a route (or of all) in the window: { n, p50, p95, p99, max } in ms. */
  function latencies(route) {
    const m = windowOf(route).map((x) => x.ms);
    return { n: m.length, p50: percentile(m, 50), p95: percentile(m, 95), p99: percentile(m, 99), max: m.length ? Math.max(...m) : null };
  }

  /**
   * SLO: availability target (0.995) and, optionally, a latency target (requests slower than `thresholdMs` count as bad).
   * The error budget is how much can fail without breaking the target: (1 - target) · requests.
   */
  function slo({ target = 0.995, route = null, thresholdMs = null } = {}) {
    const m = windowOf(route);
    const n = m.length;
    const bad = m.filter((x) => !x.ok || (thresholdMs != null && x.ms > thresholdMs)).length;
    const allowed = (1 - target) * n;
    return {
      n, bad, target,
      met: n === 0 ? null : 1 - bad / n,
      budgetTotal: allowed,
      budgetSpent: allowed ? bad / allowed : (bad ? Infinity : 0),   // 1 = exhausted
      withinTarget: n === 0 ? true : 1 - bad / n >= target,
    };
  }

  function prometheus() {
    const out = [];
    const typeOf = (k) => k.slice(0, k.indexOf('{'));
    const seen = new Set();
    const header = (k, t) => { const n = typeOf(k); if (!seen.has(n)) { seen.add(n); out.push(`# TYPE ${n} ${t}`); } };
    for (const [k, v] of counters) { header(k, 'counter'); out.push(`${k.replace('{}', '')} ${v}`); }
    for (const [k, v] of gauges) { header(k, 'gauge'); out.push(`${k.replace('{}', '')} ${v}`); }
    for (const [k, h] of histos) {
      header(k, 'histogram');
      const n = typeOf(k), lb = k.slice(k.indexOf('{') + 1, -1), sep = lb ? ',' : '';
      let acc = 0;
      buckets.forEach((c, i) => { acc += h.counts[i]; out.push(`${n}_bucket{${lb}${sep}le="${c}"} ${acc}`); });
      out.push(`${n}_bucket{${lb}${sep}le="+Inf"} ${h.n}`, `${n}_sum${lb ? `{${lb}}` : ''} ${h.sum}`, `${n}_count${lb ? `{${lb}}` : ''} ${h.n}`);
    }
    return out.join('\n') + '\n';
  }

  return { count, gauge, observe, measure, record, latencies, slo, percentile, prometheus };
}
