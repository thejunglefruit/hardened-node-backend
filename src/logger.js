// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// JSON-lines logger (one line = one event) with secrets redacted and size-based rotation.
// What must NOT end up in a log: API keys, tokens, passwords, full phone numbers.
import fs from 'node:fs';
import path from 'node:path';

const SECRET_KEYS = /apikey|api_key|token|secret|password|passwd|authorization|cookie|pepper/i;
const PHONE = /^\+?\d{8,15}$/;
const IN_URL = /((?:apikey|token|key|secret)=)[^&\s"']+/gi;

export function redact(value, key = '') {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (SECRET_KEYS.test(key)) return '***';
    if (PHONE.test(value)) return value.slice(0, 3) + '…' + value.slice(-2);
    return value.replace(IN_URL, '$1***');
  }
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (typeof value === 'object') {
    if (value instanceof Error) return { error: value.message, stack: value.stack?.split('\n').slice(0, 4).join(' | ') };
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '***' : redact(v, k);
    return out;
  }
  return value;
}

export function createLogger({ path: file = null, maxBytes = 5 * 1024 * 1024, copies = 5, console: toConsole = true, level = 'info', sink = null } = {}) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const minimum = levels[level] ?? 1;
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });

  function rotate() {
    try {
      if (!file || !fs.existsSync(file) || fs.statSync(file).size < maxBytes) return;
      for (let i = copies - 1; i >= 1; i--) {
        const from = `${file}.${i}`, to = `${file}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.renameSync(file, `${file}.1`);
    } catch { /* a failed rotation must not take the server down */ }
  }

  function write(eventLevel, event, data) {
    if ((levels[eventLevel] ?? 1) < minimum) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level: eventLevel, event, ...redact(data || {}) });
    if (toConsole) (eventLevel === 'error' ? console.error : console.log)(line);
    if (sink) sink(line);
    if (file) { rotate(); try { fs.appendFileSync(file, line + '\n'); } catch { /* disk full or no permission: keep going */ } }
  }

  return {
    debug: (event, data) => write('debug', event, data),
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
    redact,
    path: file,
  };
}
