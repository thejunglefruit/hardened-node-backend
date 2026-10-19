// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// Idempotency: when a client repeats a request (retry, double click, replayed webhook) with the same
// `Idempotency-Key`, it is not executed again: the stored response is returned. Kept in SQLite with an expiry.
// A key reused with a DIFFERENT body is a client error (422), not a repeat.
import crypto from 'node:crypto';
import { HttpError } from '../errors.js';

const VALID_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

export function createIdempotency({ db, ttlMs = 24 * 3600000, now = Date.now, logger = null } = {}) {
  if (!db) throw new Error('createIdempotency: db is required');
  db.exec(`CREATE TABLE IF NOT EXISTS idempotency (
    key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, response TEXT, created INTEGER NOT NULL
  )`);
  const qGet = db.prepare('SELECT * FROM idempotency WHERE key = ?');
  const qReserve = db.prepare("INSERT INTO idempotency (key, fingerprint, status, created) VALUES (?, ?, 'running', ?)");
  const qSave = db.prepare("UPDATE idempotency SET status = 'done', response = ? WHERE key = ?");
  const qDelete = db.prepare('DELETE FROM idempotency WHERE key = ?');
  const qExpired = db.prepare('DELETE FROM idempotency WHERE created < ?');

  const fingerprintOf = (body) => crypto.createHash('sha256').update(typeof body === 'string' ? body : JSON.stringify(body ?? null)).digest('hex');

  /**
   * Runs `action()` once per key. Returns { response, repeated }.
   * `response` must be JSON-serialisable. If `action` throws, the key is released so the client can retry.
   */
  async function once(key, body, action) {
    if (typeof key !== 'string' || !VALID_KEY.test(key)) throw new HttpError(400, 'Invalid Idempotency-Key (8-128 characters: letters, digits, . _ : -)');
    qExpired.run(now() - ttlMs);
    const fingerprint = fingerprintOf(body);
    const previous = qGet.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new HttpError(422, 'Idempotency-Key already used with different content');
      if (previous.status === 'running') throw new HttpError(409, 'That request is still in progress', { retryAfter: 2 });
      logger?.info('idempotent_repeat', { key });
      return { response: JSON.parse(previous.response), repeated: true };
    }
    try { qReserve.run(key, fingerprint, now()); }
    catch { throw new HttpError(409, 'That request is still in progress', { retryAfter: 2 }); } // another request reserved it in between
    try {
      const response = await action();
      qSave.run(JSON.stringify(response ?? null), key);
      return { response, repeated: false };
    } catch (e) { qDelete.run(key); throw e; }
  }

  /** For webhooks: have I seen this event id? Marks it as seen and returns true if it was a repeat. */
  function seenEvent(eventId) {
    qExpired.run(now() - ttlMs);
    try { qReserve.run('evt:' + eventId, 'event', now()); qSave.run('null', 'evt:' + eventId); return false; }
    catch { return true; }
  }

  return { once, seenEvent, fingerprintOf };
}
