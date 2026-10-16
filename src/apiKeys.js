// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// API keys: generated from a CSPRNG, stored only as a hash (a stolen database is useless) and compared in
// constant time. The 8-character prefix is kept in clear so it can be indexed and so people can recognise their
// key ("the one starting with k7Qx...") without showing it whole.
import crypto from 'node:crypto';

export const KEY_PREFIX_LENGTH = 8;

export function generateKey(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url'); // 16 bytes = 128 bits = 22 characters
}

export function hashKey(key, pepper = '') {
  // the pepper is a server-side secret (config): with the database alone, or half the code, keys cannot be tested
  return crypto.createHash('sha256').update(pepper + String(key)).digest('hex');
}

export const keyPrefix = (key) => String(key).slice(0, KEY_PREFIX_LENGTH);

export function compareHash(a, b) {
  const ba = Buffer.from(String(a), 'utf8'), bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Does it look like one of our keys? (avoids database lookups with huge garbage) */
export function isValidKeyShape(key) {
  return typeof key === 'string' && key.length >= 8 && key.length <= 64 && /^[A-Za-z0-9_-]+$/.test(key);
}
