// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// Health checks. "Alive" = the process answers (if it fails, the supervisor restarts it).
// "Ready" = it can really serve (DB, disk, queue); if it fails, traffic is taken away but it is NOT restarted.
// Mixing them causes restart loops whenever a dependency goes down.
import fs from 'node:fs';

export function createHealth({ now = Date.now, timeoutMs = 2000 } = {}) {
  const checks = new Map(); // name → { fn, critical }
  const start = now();

  async function runCheck(name, { fn, critical }) {
    const t0 = now();
    try {
      await Promise.race([Promise.resolve().then(fn), new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), timeoutMs).unref())]);
      return { name, ok: true, critical, ms: now() - t0 };
    } catch (e) { return { name, ok: false, critical, ms: now() - t0, error: String(e?.message || e).slice(0, 120) }; }
  }

  return {
    /** Registers a check; `critical: false` reports it but does not fail "ready". */
    register(name, fn, { critical = true } = {}) { checks.set(name, { fn, critical }); },
    alive() { return { status: 200, body: { ok: true, uptimeS: Math.round((now() - start) / 1000) } }; },
    async ready() {
      const r = await Promise.all([...checks].map(([n, c]) => runCheck(n, c)));
      const ok = r.every((x) => x.ok || !x.critical);
      return { status: ok ? 200 : 503, body: { ok, checks: r.map(({ name, ok: o, ms, error }) => ({ name, ok: o, ms, ...(error ? { error } : {}) })) } };
    },
    /** Shortcut for `server.on('request', ...)`: returns true if it served /health/alive or /health/ready. */
    async handle(path, res) {
      if (path !== '/health/alive' && path !== '/health/ready') return false;
      const { status, body } = path === '/health/alive' ? this.alive() : await this.ready();
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
      return true;
    },
  };
}

// ready-made checks
export const checkDb = (db) => () => { db.prepare('SELECT 1').get(); };
export const checkDisk = (dir, minFreeBytes = 200 * 1024 * 1024) => () => {
  const s = fs.statfsSync(dir);
  if (s.bavail * s.bsize < minFreeBytes) throw new Error('low free space');
};
export const checkQueue = (queue, maxPending = 400) => () => { if (queue.pending > maxPending) throw new Error(`queue nearly full (${queue.pending})`); };
