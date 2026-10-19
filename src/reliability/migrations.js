// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// Versioned database migrations: a folder of `001_name.sql`, `002_…` files, applied in order, each in its own
// transaction and recorded in `schema_version`. Running `migrate()` again does nothing. If an already-applied
// migration changed on disk (someone edited the past) it refuses to continue: fix it with a new migration.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const NAME = /^(\d{3,})_([a-z0-9_-]+)\.sql$/i;
const fingerprint = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);

export function readMigrations(dir) {
  const files = fs.readdirSync(dir).filter((f) => NAME.test(f)).sort();
  const versions = new Set();
  return files.map((f) => {
    const [, v, name] = f.match(NAME);
    if (versions.has(+v)) throw new Error(`Duplicate migration version: ${v}`);
    versions.add(+v);
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    return { version: +v, name, file: f, sql, fingerprint: fingerprint(sql) };
  });
}

export function migrationStatus(db, dir) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, fingerprint TEXT NOT NULL, applied TEXT NOT NULL)');
  const done = new Map(db.prepare('SELECT * FROM schema_version').all().map((r) => [r.version, r]));
  const all = readMigrations(dir);
  return {
    current: Math.max(0, ...done.keys()),
    pending: all.filter((m) => !done.has(m.version)),
    modified: all.filter((m) => done.has(m.version) && done.get(m.version).fingerprint !== m.fingerprint).map((m) => m.file),
    missingOnDisk: [...done.keys()].filter((v) => !all.some((m) => m.version === v)),
  };
}

/** Applies whatever is pending. Returns the versions applied. Throws if the history does not add up. */
export function migrate(db, dir, { logger = null, now = () => new Date().toISOString() } = {}) {
  const s = migrationStatus(db, dir);
  if (s.modified.length) throw new Error(`Migrations already applied and then edited: ${s.modified.join(', ')}. Create a new one instead of editing.`);
  if (s.missingOnDisk.length) throw new Error(`The database has versions that are no longer in the folder: ${s.missingOnDisk.join(', ')}`);
  const applied = [];
  for (const m of s.pending) {
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version, name, fingerprint, applied) VALUES (?, ?, ?, ?)').run(m.version, m.name, m.fingerprint, now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      logger?.error('migration_failed', { file: m.file, error: err });
      throw new Error(`Migration ${m.file} failed (rolled back): ${err.message}`);
    }
    logger?.info('migration_applied', { file: m.file });
    applied.push(m.version);
  }
  return applied;
}
