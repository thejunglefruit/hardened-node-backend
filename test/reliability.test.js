// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// Tests for the reliability layer: each module against the failure it has to survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import {
  withTimeout, retry, backoffDelay, isRetryable, circuitBreaker, TimeoutError, CircuitOpenError,
  createIdempotency, createCache, createHealth, createMetrics, migrate, migrationStatus, createFlags, requestId, withTrace,
} from '../src/reliability/index.js';
import { createPersistentQueue } from '../src/index.js';

const noSleep = () => Promise.resolve();
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rel-'));

test('withTimeout cuts off slow work, aborts the signal and lets fast work through', async () => {
  let signal;
  await assert.rejects(withTimeout((s) => { signal = s; return new Promise(() => {}); }, 30), TimeoutError);
  assert.equal(signal.aborted, true, 'the call is told to cancel');
  assert.equal(await withTimeout(async () => 7, 100), 7);
});

test('retry: repeats network failures until success, never repeats client errors', async () => {
  let n = 0;
  const r = await retry(async () => { if (++n < 3) throw Object.assign(new Error('x'), { code: 'ECONNRESET' }); return 'ok'; }, { sleep: noSleep });
  assert.equal(r, 'ok'); assert.equal(n, 3);
  let m = 0;
  await assert.rejects(retry(async () => { m++; throw Object.assign(new Error('bad'), { status: 400 }); }, { sleep: noSleep }));
  assert.equal(m, 1, '400: not repeated');
  let k = 0;
  await assert.rejects(retry(async () => { k++; throw Object.assign(new Error('down'), { status: 503 }); }, { attempts: 3, sleep: noSleep }));
  assert.equal(k, 3, 'gives up when attempts run out');
});

test('retry: respects the time budget and Retry-After', async () => {
  let t = 0, attempts = 0;
  await assert.rejects(retry(async () => { attempts++; throw Object.assign(new Error('x'), { status: 503, retryInMs: 5000 }); },
    { attempts: 10, budgetMs: 8000, sleep: async (ms) => { t += ms; }, now: () => t }));
  assert.equal(attempts, 2, 'the second wait no longer fits the budget');
});

test('backoff grows, is capped, and jitter stays between 0 and the cap', () => {
  const plain = { jitter: false, baseMs: 100, maxMs: 1000 };
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, plain)), [100, 200, 400, 800, 1000, 1000]);
  for (let i = 0; i < 50; i++) { const e = backoffDelay(3, { baseMs: 100, maxMs: 1000 }); assert.ok(e >= 0 && e < 400); }
  assert.equal(isRetryable({ status: 429 }), true); assert.equal(isRetryable({ status: 404 }), false); assert.equal(isRetryable({ permanent: true, status: 503 }), false);
});

test('circuit breaker: opens after N failures, fails fast, probes when half-open, closes again', async () => {
  let t = 0, calls = 0, down = true;
  const c = circuitBreaker('api', { threshold: 3, cooldownMs: 1000, now: () => t });
  const call = () => c.run(async () => { calls++; if (down) throw Object.assign(new Error('x'), { status: 503 }); return 'ok'; });
  for (let i = 0; i < 3; i++) await assert.rejects(call());
  assert.equal(c.state, 'open');
  await assert.rejects(call(), CircuitOpenError);
  assert.equal(calls, 3, 'open: it does not even call');
  t = 1001; down = false;
  assert.equal(await call(), 'ok');
  assert.equal(c.state, 'closed');
  down = true; for (let i = 0; i < 3; i++) await assert.rejects(call());
  t += 1001; await assert.rejects(call());
  assert.equal(c.state, 'open', 'a failed probe opens it again');
});

test('circuit breaker: client 4xx errors do not count against the service', async () => {
  const c = circuitBreaker('api', { threshold: 2 });
  for (let i = 0; i < 5; i++) await assert.rejects(c.run(async () => { throw Object.assign(new Error('x'), { status: 404 }); }));
  assert.equal(c.state, 'closed');
});

test('idempotency: the same key does not run twice; another body with the same key is 422', async () => {
  const idem = createIdempotency({ db: new DatabaseSync(':memory:') });
  let runs = 0;
  const action = async () => { runs++; return { id: 42 }; };
  const a = await idem.once('key-12345678', { x: 1 }, action);
  const b = await idem.once('key-12345678', { x: 1 }, action);
  assert.deepEqual([a.repeated, b.repeated, runs], [false, true, 1]);
  assert.deepEqual(b.response, { id: 42 });
  await assert.rejects(idem.once('key-12345678', { x: 2 }, action), (e) => e.status === 422);
  await assert.rejects(idem.once('short', {}, action), (e) => e.status === 400);
});

test('idempotency: simultaneous requests with one key run once; a failure releases the key', async () => {
  const idem = createIdempotency({ db: new DatabaseSync(':memory:') });
  let runs = 0;
  const slow = async () => { runs++; await new Promise((r) => setTimeout(r, 30)); return 'done'; };
  const r = await Promise.allSettled([1, 2, 3].map(() => idem.once('key-simultaneous', {}, slow)));
  assert.equal(runs, 1);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  assert.ok(r.filter((x) => x.status === 'rejected').every((x) => x.reason.status === 409));
  await assert.rejects(idem.once('key-that-fails', {}, async () => { throw new Error('boom'); }));
  assert.equal((await idem.once('key-that-fails', {}, async () => 'now ok')).response, 'now ok', 'after a failure it can be retried');
});

test('idempotency: expires, and a repeated webhook event is detected', () => {
  let t = 1000;
  const idem = createIdempotency({ db: new DatabaseSync(':memory:'), ttlMs: 100, now: () => t });
  assert.equal(idem.seenEvent('evt_1'), false); assert.equal(idem.seenEvent('evt_1'), true); assert.equal(idem.seenEvent('evt_2'), false);
  t += 500;
  assert.equal(idem.seenEvent('evt_1'), false, 'forgotten after the TTL');
});

test('dead-letter set: after exhausting attempts a job is kept, listed, alerted and can be requeued', async () => {
  const db = new DatabaseSync(':memory:');
  let broken = true, alerts = 0; const done = [];
  const q = createPersistentQueue({ db, channel: 'x', maxAttempts: 2, baseRetryMs: 1, onDead: () => alerts++,
    process: async (p) => { if (broken) throw new Error('service down'); done.push(p.n); } });
  q.push({ n: 1 }); q.start();
  for (let i = 0; i < 100 && q.dead === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(q.dead, 1); assert.equal(alerts, 1);
  const [j] = q.listDead();
  assert.deepEqual(j.payload, { n: 1 }); assert.match(j.error, /service down/);
  broken = false;
  assert.equal(q.requeue(j.id), true);
  for (let i = 0; i < 100 && done.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  await q.stop();
  assert.deepEqual(done, [1]); assert.equal(q.dead, 0);
  assert.equal(q.requeue(9999), false);
});

test('cache: LRU, TTL, stampede protection and tags', async () => {
  let t = 0;
  const c = createCache({ max: 2, ttlMs: 100, now: () => t });
  c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3);
  assert.deepEqual([c.get('a'), c.get('b'), c.get('c')], [1, undefined, 3], 'the least recently used (b) is evicted');
  t = 200; assert.equal(c.get('a'), undefined, 'expired');
  let computes = 0;
  const slow = async () => { computes++; await new Promise((r) => setTimeout(r, 20)); return 'v'; };
  const r = await Promise.all(Array.from({ length: 20 }, () => c.getOrSet('k', slow)));
  assert.equal(computes, 1, '20 simultaneous requests, 1 computation'); assert.ok(r.every((x) => x === 'v'));
  await assert.rejects(c.getOrSet('err', async () => { throw new Error('x'); }));
  assert.equal(c.get('err'), undefined, 'errors are not cached');
  const d = createCache(); d.set('u1', 1, { tags: ['user:7'] }); d.set('u2', 2, { tags: ['user:7'] }); d.set('o', 3, { tags: ['user:8'] });
  assert.equal(d.invalidateTag('user:7'), 2); assert.equal(d.get('o'), 3);
});

test('health: alive always; ready fails (503) if a critical dependency is down, not if an optional one is', async () => {
  const h = createHealth({ timeoutMs: 50 });
  h.register('db', () => {}); h.register('extra', () => { throw new Error('x'); }, { critical: false });
  assert.equal((await h.ready()).status, 200);
  h.register('slow', () => new Promise(() => {}));
  const r = await h.ready();
  assert.equal(r.status, 503);
  assert.equal(r.body.checks.find((c) => c.name === 'slow').error, 'timeout');
  assert.equal(h.alive().status, 200);
});

test('metrics: exact percentiles, Prometheus histogram and error budget', () => {
  const m = createMetrics();
  for (let i = 1; i <= 100; i++) m.record('/api', i === 100 ? 500 : 200, i);   // 1..100 ms, one 500
  const l = m.latencies('/api');
  assert.deepEqual([l.n, l.p50, l.p95, l.p99, l.max], [100, 50, 95, 99, 100]);
  const slo = m.slo({ target: 0.99, route: '/api' });
  assert.equal(slo.bad, 1); assert.equal(slo.withinTarget, true); assert.ok(Math.abs(slo.budgetSpent - 1) < 1e-9, 'exactly exhausted');
  assert.equal(m.slo({ target: 0.999, route: '/api' }).withinTarget, false);
  assert.equal(m.slo({ target: 0.99, route: '/api', thresholdMs: 90 }).bad, 10, '91..100 ms are slow; the 500 is one of them and is not counted twice');
  const p = m.prometheus();
  assert.match(p, /http_requests_total\{class="2xx",route="\/api"\} 99/);
  assert.match(p, /http_duration_seconds_bucket\{route="\/api",le="\+Inf"\} 100/);
  assert.match(p, /http_duration_seconds_count\{route="\/api"\} 100/);
});

test('metrics: measure(res) records status and duration on close; hostile label values cannot break the format', () => {
  const m = createMetrics(); const res = new EventEmitter(); res.statusCode = 404;
  m.measure(res, '/x'); res.emit('close');
  assert.equal(m.latencies('/x').n, 1);
  m.count('evil', { v: 'a"b\nc' });
  assert.ok(!m.prometheus().includes('a"b'));
});

test('migrations: apply in order, idempotent, roll back the failing one, refuse if the past was edited', () => {
  const dir = tmpDir(), db = new DatabaseSync(':memory:');
  fs.writeFileSync(path.join(dir, '001_users.sql'), 'CREATE TABLE u (id INTEGER PRIMARY KEY, n TEXT);');
  fs.writeFileSync(path.join(dir, '002_index.sql'), 'CREATE INDEX u_n ON u(n);');
  assert.deepEqual(migrate(db, dir), [1, 2]);
  assert.deepEqual(migrate(db, dir), [], 'running again does nothing');
  fs.writeFileSync(path.join(dir, '003_broken.sql'), 'ALTER TABLE u ADD COLUMN a TEXT; THIS IS NOT SQL;');
  assert.throws(() => migrate(db, dir), /003_broken.sql failed/);
  assert.equal(migrationStatus(db, dir).current, 2);
  assert.throws(() => db.prepare('SELECT a FROM u').all(), 'the half-applied column was rolled back');
  fs.rmSync(path.join(dir, '003_broken.sql'));
  fs.writeFileSync(path.join(dir, '001_users.sql'), 'CREATE TABLE u (id INTEGER PRIMARY KEY, n TEXT, extra TEXT);');
  assert.throws(() => migrate(db, dir), /edited/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrations: duplicate versions are rejected', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '001_a.sql'), 'SELECT 1;'); fs.writeFileSync(path.join(dir, '001_b.sql'), 'SELECT 2;');
  assert.throws(() => migrate(new DatabaseSync(':memory:'), dir), /Duplicate/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('flags: reload when the file changes, stable % per user, a broken file keeps the previous flags', () => {
  const dir = tmpDir(), file = path.join(dir, 'flags.json');
  fs.writeFileSync(file, JSON.stringify({ fresh: { on: true, percent: 30 }, maint: false }));
  let t = 0; const f = createFlags({ file, now: () => t, checkEveryMs: 10 });
  const inside = Array.from({ length: 1000 }, (_, i) => f.isOn('fresh', 'u' + i)).filter(Boolean).length;
  assert.ok(inside > 230 && inside < 370, `≈30 % (got ${inside})`);
  assert.equal(f.isOn('fresh', 'u5'), f.isOn('fresh', 'u5'), 'stable');
  assert.equal(f.isOn('fresh'), false, 'no id and a % rollout: off');
  assert.equal(f.isOn('unknown'), false); assert.equal(f.isOn('unknown', null, true), true);
  t = 100; fs.writeFileSync(file, JSON.stringify({ fresh: true })); fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(f.isOn('fresh'), true, 'reloaded');
  t = 200; fs.writeFileSync(file, '{broken'); fs.utimesSync(file, new Date(), new Date(Date.now() + 9000));
  assert.equal(f.isOn('fresh'), true, 'broken JSON: the previous flags are kept');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tracing: accepts a sane id, rejects a hostile one, and adds it to the logger', () => {
  assert.equal(requestId({ headers: { 'x-request-id': 'abc-12345678' } }), 'abc-12345678');
  const bad = requestId({ headers: { 'x-request-id': 'a\r\nSet-Cookie: x=1' } });
  assert.ok(!bad.includes('Set-Cookie') && bad.length === 36, 'header injection: ignored, a new id is generated');
  const lines = []; const log = { info: (e, d) => lines.push({ e, d }), debug() {}, warn() {}, error() {} };
  const headers = {}; const res = { setHeader: (k, v) => (headers[k] = v) };
  const { id, logger } = withTrace({ headers: {} }, res, log);
  logger.info('hello', { x: 1 });
  assert.equal(headers['x-request-id'], id); assert.deepEqual(lines[0], { e: 'hello', d: { id, x: 1 } });
});
