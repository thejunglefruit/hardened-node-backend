// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// Unit and integration tests against the example server. Each test is a known attack and what the kit must answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createExampleServer } from '../examples/server.js';
import { isPrivateIp, checkUrl, safeFetch, redact, createRateLimiter, createFailureCounter, generateKey, hashKey, compareHash, createPersistentQueue } from '../src/index.js';

async function boot(options) {
  const s = createExampleServer(options);
  await new Promise((r) => s.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.server.address().port}`;
  const ask = (route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request(base + route, { method, headers }, (res) => {
      let data = ''; res.on('data', (d) => (data += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
  const close = async () => { await s.queue.stop(); s.server.close(); };
  return { ...s, base, ask, close };
}

test('public routes: only that route, only that origin, read-only', async () => {
  const s = await boot();
  try {
    const site = { origin: 'https://www.example.test' };
    const ok = await s.ask('/health', { headers: site });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['access-control-allow-origin'], 'https://www.example.test');
    assert.equal(ok.headers['access-control-allow-credentials'], undefined, 'no credentials');
    const pre = await s.ask('/health', { method: 'OPTIONS', headers: site });
    assert.equal(pre.status, 204);
    assert.equal((await s.ask('/health', { method: 'POST', headers: site })).status, 403, 'POST from the site: no');
    assert.equal((await s.ask('/signup', { headers: site })).status, 403, 'another route from the site: no');
    assert.equal((await s.ask('/health', { headers: { origin: 'https://www.example.test.evil.com' } })).status, 403, 'look-alike origin: no');
    assert.equal((await s.ask('/health', { headers: { origin: 'null' } })).status, 403);
    assert.equal((await s.ask('/health?x=1', { headers: site })).status, 200, 'a query string is still that route');
  } finally { await s.close(); }
});

test('security headers and errors without detail', async () => {
  const s = await boot();
  try {
    const r = await s.ask('/signup');
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.ok(!r.headers['access-control-allow-origin'], 'never CORS');
    const e = await s.ask('/crash?apikey=LEAKME123');
    assert.equal(e.status, 500);
    assert.equal(JSON.parse(e.text).message, 'Internal error');
    assert.ok(!e.text.includes('LEAKME123') && !e.text.includes('internal detail'));
  } finally { await s.close(); }
});

test('foreign Origin and "null" rejected; own origin and none pass', async () => {
  const s = await boot();
  try {
    assert.equal((await s.ask('/signup', { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await s.ask('/signup', { headers: { origin: 'null' } })).status, 403);
    assert.equal((await s.ask('/signup', { headers: { origin: 'https://api.example.test' } })).status, 200);
    assert.equal((await s.ask('/signup')).status, 200);
  } finally { await s.close(); }
});

test('keys: hashed at rest, constant-time compare, brute force blocked per IP', async () => {
  const s = await boot({ failures: { maxFailures: 5, windowMs: 60000, blockMs: 60000 } });
  try {
    const key = JSON.parse((await s.ask('/signup')).text).apikey;
    assert.ok(key.length >= 22);
    const row = s.db.prepare('SELECT * FROM users').get();
    assert.ok(!row.hash.includes(key) && row.hash.length === 64, 'the key is not stored in clear');
    assert.equal((await s.ask(`/send?apikey=${key}&text=hi`)).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await s.ask(`/send?apikey=wrong${i}xxxxxx&text=hi`)).status, 403);
    const blocked = await s.ask(`/send?apikey=${key}&text=hi`);
    assert.equal(blocked.status, 429, 'after 5 failures the IP is blocked even with a good key');
    assert.ok(blocked.headers['retry-after']);
    assert.equal((await s.ask('/send?apikey=' + encodeURIComponent("' OR 1=1 --") + '&text=x')).status, 429);
  } finally { await s.close(); }
});

test('bursts: the token bucket answers 429 and the queue has a cap', async () => {
  const s = await boot({ rateLimit: { capacity: 10, perSecond: 0.001 }, process: () => new Promise(() => {}) });
  try {
    const key = JSON.parse((await s.ask('/signup')).text).apikey;
    const statuses = [];
    for (let i = 0; i < 9; i++) statuses.push((await s.ask(`/send?apikey=${key}&text=${i}`)).status);
    assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.ok(statuses.slice(5).includes(429), 'with the queue full (5) the queue 429 arrives');
    assert.equal((await s.ask('/signup')).status, 429, 'tokens exhausted for this IP: everything is 429');
  } finally { await s.close(); }
});

test('huge bodies and URLs', async () => {
  const s = await boot();
  try {
    const big = await s.ask('/send', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'text=' + 'a'.repeat(200 * 1024) });
    assert.equal(big.status, 413);
    assert.equal((await s.ask('/signup?x=' + 'b'.repeat(3000))).status, 414);
    assert.equal((await s.ask('/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })).status, 400);
  } finally { await s.close(); }
});

test('SSRF: private addresses, local names, odd schemes and ports', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.3.3', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.1.1', '::1', 'fe80::1', 'fd00::1', '::ffff:192.168.0.1', '224.0.0.1']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.ok(!isPrivateIp(ip), ip);
  for (const url of ['http://127.0.0.1:8930/', 'https://192.168.1.1/', 'https://localhost/x', 'https://router.local/', 'https://[::1]/', 'https://1.2.3.4:8080/', 'ftp://1.2.3.4/', 'https://user:pw@1.2.3.4/', 'https://169.254.169.254/latest/meta-data/']) {
    await assert.rejects(checkUrl(url, { httpsOnly: false }), (e) => e.status === 400, url);
  }
  const ok = await checkUrl('https://1.1.1.1/cdn-cgi/trace');
  assert.equal(ok.ip, '1.1.1.1');
  const s = await boot();
  try {
    const key = JSON.parse((await s.ask('/signup')).text).apikey;
    const r = await s.ask(`/send?apikey=${key}&text=x&image=${encodeURIComponent('http://127.0.0.1/health')}`);
    assert.equal(r.status, 400);
    assert.match(JSON.parse(r.text).message, /Destination not allowed/);
    const r2 = await s.ask(`/send?apikey=${key}&text=x&image=${encodeURIComponent('http://127.0.0.1:8930/health')}`);
    assert.equal(r2.status, 400);
    assert.match(JSON.parse(r2.text).message, /Port not allowed/);
  } finally { await s.close(); }
});

test('SSRF: numeric variants, IDN dots, userinfo, trailing dot and redirect to a private host', async () => {
  for (const url of ['http://2130706433/', 'http://0x7f.1/', 'http://017700000001/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://evil@127.0.0.1/', 'http://127。0。0。1/', 'http://localhost./', 'http://metadata.google.internal./']) {
    await assert.rejects(checkUrl(url, { httpsOnly: false }), (e) => e.status === 400, url);
  }
  // the FQDN trailing dot must not slip past the name list even in the quick check (skipDns)
  for (const url of ['http://localhost./', 'http://metadata.google.internal./']) {
    await assert.rejects(checkUrl(url, { httpsOnly: false, skipDns: true }), (e) => e.status === 400, 'quick ' + url);
  }
  const inner = http.createServer((_q, s) => s.end('internal'));
  await new Promise((r) => inner.listen(0, '127.0.0.1', r));
  const redirector = http.createServer((_q, s) => { s.writeHead(302, { location: `http://127.0.0.1:${inner.address().port}/` }); s.end(); });
  await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(safeFetch(`http://127.0.0.1:${redirector.address().port}/`, { httpsOnly: false, ports: [redirector.address().port] }), (e) => e.status === 400);
  } finally { inner.close(); redirector.close(); }
});

test('logger: secrets and phone numbers redacted', () => {
  const r = redact({ apikey: 'abc', token: 'xyz', phone: '34600111222', url: 'https://x/y?text=hi&apikey=S3CR3T&z=1', nested: { password: 'p', ok: 'yes' } });
  assert.deepEqual(r, { apikey: '***', token: '***', phone: '346…22', url: 'https://x/y?text=hi&apikey=***&z=1', nested: { password: '***', ok: 'yes' } });
});

test('units: rate limiter, failure counter and keys', () => {
  let t = 0; const now = () => t;
  const l = createRateLimiter({ capacity: 2, perSecond: 1, now });
  assert.ok(l.allow('a').ok); assert.ok(l.allow('a').ok); assert.ok(!l.allow('a').ok);
  t = 1000; assert.ok(l.allow('a').ok);
  const f = createFailureCounter({ maxFailures: 2, windowMs: 1000, blockMs: 5000, now });
  assert.equal(f.fail('b'), false); assert.equal(f.fail('b'), true); assert.ok(f.blocked('b') > 0);
  t = 7000; assert.equal(f.blocked('b'), 0);
  const k = generateKey();
  assert.ok(compareHash(hashKey(k, 'p'), hashKey(k, 'p')) && !compareHash(hashKey(k, 'p'), hashKey(k, 'q')));
  // memory does not grow without bound
  const big = createRateLimiter({ maxKeys: 100 });
  for (let i = 0; i < 1000; i++) big.allow('ip' + i);
  assert.ok(big.size <= 100);
});

test('persistent queue: survives a restart and retries', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  let attempts = 0; const done = [];
  const work = async (x) => { attempts++; if (attempts === 1) throw new Error('temporary failure'); done.push(x.n); };
  const q = createPersistentQueue({ db, channel: 'c', max: 3, baseRetryMs: 10, process: work });
  q.push({ n: 1 }); q.push({ n: 2 });
  db.prepare("UPDATE job_queue SET status = 'running' WHERE id = 1").run(); // simulates a crash mid-job
  const q2 = createPersistentQueue({ db, channel: 'c', max: 3, baseRetryMs: 10, process: work });
  assert.equal(q2.pending, 2, 'what was running goes back to pending');
  q2.start();
  for (let i = 0; i < 50 && done.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  await q2.stop();
  assert.deepEqual(done.sort(), [1, 2]);
  assert.ok(attempts >= 3, 'the first one was retried');
  q2.push({ n: 3 }); q2.push({ n: 4 }); q2.push({ n: 5 });
  assert.throws(() => q2.push({ n: 6 }), (e) => e.status === 429);
});
