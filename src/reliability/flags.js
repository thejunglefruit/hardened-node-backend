// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// Feature flags from a JSON file that reloads itself when it changes (no restart): switch a feature on or off, or roll it
// out gradually to a % of users (canary). The % split is stable: the same user always lands on the same side.
//   { "new_send": { "on": true, "percent": 10 }, "maintenance": { "on": false } }
import fs from 'node:fs';
import crypto from 'node:crypto';

const bucket = (name, id) => crypto.createHash('sha256').update(`${name}:${id}`).digest().readUInt32BE(0) % 100;

export function createFlags({ file = null, initial = {}, logger = null, now = Date.now, checkEveryMs = 2000 } = {}) {
  let data = { ...initial }, mtime = 0, lastCheck = -Infinity;   // -Infinity: the first lookup always reads the file

  function reload() {
    if (!file || now() - lastCheck < checkEveryMs) return;
    lastCheck = now();
    try {
      const m = fs.statSync(file).mtimeMs;
      if (m === mtime) return;
      const next = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('the JSON must be an object');
      data = next; mtime = m;
      logger?.info('flags_reloaded', { n: Object.keys(next).length });
    } catch (e) { logger?.warn('flags_error', { error: e }); }   // a broken file keeps the previous flags
  }

  /** Is `name` on? With an `id` (user) the percentage is applied stably. Unknown flags return `fallback` (off). */
  function isOn(name, id = null, fallback = false) {
    reload();
    const f = Object.hasOwn(data, name) ? data[name] : null;
    if (f == null) return fallback;
    if (typeof f === 'boolean') return f;
    if (!f.on) return false;
    if (f.percent == null || f.percent >= 100) return true;
    if (id == null) return false;
    return bucket(name, id) < f.percent;
  }
  return { isOn, all: () => { reload(); return { ...data }; } };
}
