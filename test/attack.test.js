// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// The full attack battery must stop every attack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAttacks } from '../attack/attack.mjs';

test('attack battery: every attack is stopped', async () => {
  const results = await runAttacks();
  const failed = results.filter((r) => !r.ok).map((r) => `${r.family}: expected ${r.expected}, got ${r.got}`);
  assert.deepEqual(failed, []);
  assert.ok(results.length >= 20);
});
