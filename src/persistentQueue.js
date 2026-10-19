// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// Job queue stored in SQLite: if the process dies, pending work is still there when it comes back. It has a cap
// (an attacker cannot enqueue until memory bursts), retries with exponential backoff and an optional random pause
// between jobs (messaging services punish bursts).
import { HttpError } from './errors.js';

export function createPersistentQueue({
  db, channel, process: handle, max = 500, maxAttempts = 5, minPauseMs = 0, maxPauseMs = 0, baseRetryMs = 5000, maxBackoffMs = 3600000, logger = null, now = Date.now,
  onDead = null, // (job) => void, to alert when a job moves to the dead-letter set
}) {
  if (!db || !channel || typeof handle !== 'function') throw new Error('createPersistentQueue: db, channel and process are required');
  db.exec(`CREATE TABLE IF NOT EXISTS job_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL, next_at INTEGER NOT NULL, error TEXT
  ); CREATE INDEX IF NOT EXISTS job_queue_channel_status ON job_queue(channel, status, next_at)`);
  // whatever was "running" when the process died goes back to pending
  db.prepare("UPDATE job_queue SET status = 'pending' WHERE channel = ? AND status = 'running'").run(channel);
  // dead-letter set: what exhausted its attempts stays as 'failed' (never lost), and can be listed and requeued by hand
  const qDead = db.prepare("SELECT id, attempts, created, error, payload FROM job_queue WHERE channel = ? AND status = 'failed' ORDER BY id LIMIT ?");
  const qDeadCount = db.prepare("SELECT COUNT(*) AS n FROM job_queue WHERE channel = ? AND status = 'failed'");
  const qRequeue = db.prepare("UPDATE job_queue SET status = 'pending', attempts = 0, next_at = ?, error = NULL WHERE id = ? AND channel = ? AND status = 'failed'");

  const qPending = db.prepare("SELECT COUNT(*) AS n FROM job_queue WHERE channel = ? AND status IN ('pending','running')");
  const qInsert = db.prepare('INSERT INTO job_queue (channel, payload, created, next_at) VALUES (?, ?, ?, ?)');
  const qNext = db.prepare("SELECT * FROM job_queue WHERE channel = ? AND status = 'pending' AND next_at <= ? ORDER BY next_at, id LIMIT 1");
  const qRunning = db.prepare("UPDATE job_queue SET status = 'running' WHERE id = ?");
  const qDone = db.prepare('DELETE FROM job_queue WHERE id = ?');
  const qRetry = db.prepare("UPDATE job_queue SET status = 'pending', attempts = ?, next_at = ?, error = ? WHERE id = ?");
  const qFailed = db.prepare("UPDATE job_queue SET status = 'failed', attempts = ?, error = ? WHERE id = ?");
  const qPurge = db.prepare("DELETE FROM job_queue WHERE channel = ? AND status = 'failed' AND created < ?");
  const qSoonest = db.prepare("SELECT MIN(next_at) AS t FROM job_queue WHERE channel = ? AND status = 'pending'");

  let active = false, loop = null, wake = null;
  const sleep = (ms) => new Promise((r) => { wake = r; setTimeout(() => { wake = null; r(); }, ms).unref(); });

  async function run() {
    while (active) {
      const row = qNext.get(channel, now());
      if (!row) {
        // sleep until the next scheduled retry (or 1 s), unless something new arrives (wake)
        const soonest = qSoonest.get(channel).t;
        await sleep(soonest ? Math.max(10, Math.min(1000, soonest - now())) : 1000);
        continue;
      }
      qRunning.run(row.id);
      try {
        await handle(JSON.parse(row.payload), row);
        qDone.run(row.id);
      } catch (e) {
        const attempts = row.attempts + 1;
        const message = String(e?.message || e).slice(0, 300);
        if (attempts >= maxAttempts || e?.permanent) {
          qFailed.run(attempts, message, row.id);
          logger?.error('queue_permanent_failure', { channel, id: row.id, attempts, error: message });
          try { onDead?.({ id: row.id, attempts, error: message }); } catch { /* a broken alert must not stop the queue */ }
        } else {
          const wait = Math.min(maxBackoffMs, baseRetryMs * 2 ** (attempts - 1));
          qRetry.run(attempts, now() + wait, message, row.id);
          logger?.warn('queue_retry', { channel, id: row.id, attempts, inMs: wait, error: message });
        }
      }
      if (maxPauseMs > 0) await sleep(minPauseMs + Math.random() * (maxPauseMs - minPauseMs));
    }
  }

  return {
    /** Enqueues; throws 429 if the queue is full. Returns the id. */
    push(payload) {
      if (qPending.get(channel).n >= max) throw new HttpError(429, 'Queue full, retry in a few minutes', { retryAfter: 60 });
      const r = qInsert.run(channel, JSON.stringify(payload), now(), now());
      if (wake) wake();
      return Number(r.lastInsertRowid);
    },
    get pending() { return qPending.get(channel).n; },
    get dead() { return qDeadCount.get(channel).n; },
    /** Jobs that exhausted their attempts (payload already parsed). */
    listDead(limit = 50) { return qDead.all(channel, limit).map((j) => ({ ...j, payload: JSON.parse(j.payload) })); },
    /** Puts a dead job back in the queue with its attempts reset. Returns true if it existed. */
    requeue(id) { const r = qRequeue.run(now(), id, channel).changes > 0; if (r && wake) wake(); return r; },
    start() { if (active) return; active = true; loop = run(); },
    /** Stops the loop; if a job hangs, waits no longer than `maxWaitMs` (it stays "running" and returns to pending on the next start). */
    async stop(maxWaitMs = 3000) {
      active = false;
      if (wake) wake();
      await Promise.race([loop, new Promise((r) => setTimeout(r, maxWaitMs).unref())]);
    },
    purgeFailed(olderThanMs = 7 * 86400000) { return qPurge.run(channel, now() - olderThanMs).changes; },
  };
}
