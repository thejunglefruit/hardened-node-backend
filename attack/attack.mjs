// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// Attack battery: boots the example server in this same process on 127.0.0.1 (random port, in-memory SQLite),
// throws known attack families at it and prints attack -> expected -> got -> OK.
//
//   node attack/attack.mjs                 table on the terminal, exit code 1 if anything fails
//   node attack/attack.mjs --json          machine-readable results
//   node attack/attack.mjs --svg out.svg   also renders the table as an SVG image
//
// It only ever talks to servers it starts itself on the loopback interface. Copy it next to your own app and
// swap `createExampleServer` for your server factory.
import http from 'node:http';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createExampleServer } from '../examples/server.js';
import { checkUrl, createRateLimiter, createLogger } from '../src/index.js';

async function boot(options = {}) {
  const lines = [];
  const logger = createLogger({ console: false, sink: (l) => lines.push(l) });
  const s = createExampleServer({ logger, ...options });
  await new Promise((r) => s.server.listen(0, '127.0.0.1', r));
  const port = s.server.address().port;
  const ask = (route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers }, (res) => {
      let data = ''; res.on('data', (d) => (data += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, text: '', error: e.code || e.message }));
    if (body) req.write(body);
    req.end();
  });
  const close = async () => { await s.queue.stop(); await new Promise((r) => s.server.close(r)); };
  return { ...s, ask, close, lines, port };
}

const signUp = async (s) => JSON.parse((await s.ask('/signup')).text).apikey;

// Each family: [family, attack, expected, async () => ({ got, ok })]
const FAMILIES = [
  ['Brute force', '5 wrong API keys, then the right one', '429 + Retry-After', async () => {
    const s = await boot({ failures: { maxFailures: 5, windowMs: 60000, blockMs: 60000 } });
    try {
      const key = await signUp(s);
      for (let i = 0; i < 5; i++) await s.ask(`/send?apikey=wrong${i}xxxxxxx&text=hi`);
      const r = await s.ask(`/send?apikey=${key}&text=hi`);
      return { got: `${r.status}, retry-after ${r.headers['retry-after'] ?? '-'}`, ok: r.status === 429 && !!r.headers['retry-after'] };
    } finally { await s.close(); }
  }],
  ['IP spoofing', 'forged X-Forwarded-For / CF-Connecting-IP per try', 'still blocked', async () => {
    const s = await boot({ failures: { maxFailures: 5, windowMs: 60000, blockMs: 60000 } });
    try {
      for (let i = 0; i < 6; i++) await s.ask(`/send?apikey=wrong${i}xxxxxxx&text=hi`, { headers: { 'x-forwarded-for': `203.0.113.${i}`, 'cf-connecting-ip': `198.51.100.${i}` } });
      const r = await s.ask('/health', { headers: { 'x-forwarded-for': '203.0.113.99', 'cf-connecting-ip': '198.51.100.99' } });
      return { got: String(r.status), ok: r.status === 429 };
    } finally { await s.close(); }
  }],
  ['Request flood', '200 requests in a row from one IP', '429 after the bucket', async () => {
    const s = await boot({ rateLimit: { capacity: 60, perSecond: 1 } });
    try {
      let first429 = 0;
      for (let i = 1; i <= 200; i++) { const r = await s.ask('/health'); if (r.status === 429 && !first429) first429 = i; }
      return { got: `first 429 at #${first429}`, ok: first429 > 0 && first429 <= 62 };
    } finally { await s.close(); }
  }],
  ['Queue flooding', 'enqueue 20 jobs into a 5-slot queue', '429 Queue full', async () => {
    const s = await boot({ process: () => new Promise(() => {}) });
    try {
      const key = await signUp(s);
      const statuses = [];
      for (let i = 0; i < 20; i++) statuses.push((await s.ask(`/send?apikey=${key}&text=${i}`)).status);
      const accepted = statuses.filter((x) => x === 200).length;
      return { got: `${accepted} accepted, then ${statuses.at(-1)}`, ok: accepted <= 5 && statuses.at(-1) === 429 };
    } finally { await s.close(); }
  }],
  ['Body bomb', 'POST a 200 KB form body', '413', async () => {
    const s = await boot();
    try {
      const r = await s.ask('/send', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'text=' + 'a'.repeat(200 * 1024) });
      return { got: String(r.status), ok: r.status === 413 };
    } finally { await s.close(); }
  }],
  ['Body flood', 'POST 2 MB, then check the server is alive', '413 or cut; still serving', async () => {
    const s = await boot();
    try {
      const r = await s.ask('/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(2 * 1024 * 1024) });
      const alive = await s.ask('/health');
      return { got: `${r.status || r.error}; health ${alive.status}`, ok: (r.status === 413 || r.status === 0) && alive.status === 200 };
    } finally { await s.close(); }
  }],
  ['URL bomb', 'GET with a 3 KB query string', '414', async () => {
    const s = await boot();
    try { const r = await s.ask('/signup?x=' + 'b'.repeat(3000)); return { got: String(r.status), ok: r.status === 414 }; } finally { await s.close(); }
  }],
  ['Malformed JSON', 'POST {not json', '400', async () => {
    const s = await boot();
    try { const r = await s.ask('/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' }); return { got: String(r.status), ok: r.status === 400 }; } finally { await s.close(); }
  }],
  ['Prototype pollution', 'POST {"__proto__":{"polluted":true}}', 'Object.prototype clean', async () => {
    const s = await boot();
    try {
      const key = await signUp(s);
      await s.ask('/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"apikey":"${key}","text":"x","__proto__":{"polluted":true}}` });
      return { got: ({}).polluted === undefined ? 'clean' : 'POLLUTED', ok: ({}).polluted === undefined };
    } finally { await s.close(); }
  }],
  ['Cross-site request', 'Origin: https://evil.example', '403', async () => {
    const s = await boot();
    try { const r = await s.ask('/signup', { headers: { origin: 'https://evil.example' } }); return { got: String(r.status), ok: r.status === 403 }; } finally { await s.close(); }
  }],
  ['Sandboxed iframe', 'Origin: null', '403', async () => {
    const s = await boot();
    try { const r = await s.ask('/signup', { headers: { origin: 'null' } }); return { got: String(r.status), ok: r.status === 403 }; } finally { await s.close(); }
  }],
  ['Look-alike origin', 'public route from www.example.test.evil.com', '403', async () => {
    const s = await boot();
    try { const r = await s.ask('/health', { headers: { origin: 'https://www.example.test.evil.com' } }); return { got: String(r.status), ok: r.status === 403 }; } finally { await s.close(); }
  }],
  ['CORS write', 'POST to the public read-only route', '403', async () => {
    const s = await boot();
    try { const r = await s.ask('/health', { method: 'POST', headers: { origin: 'https://www.example.test' } }); return { got: String(r.status), ok: r.status === 403 }; } finally { await s.close(); }
  }],
  ['Error leak', 'trigger an exception carrying a secret', '500 "Internal error"', async () => {
    const s = await boot();
    try {
      const r = await s.ask('/crash?apikey=LEAKME123');
      const clean = !r.text.includes('LEAKME123') && !r.text.includes('internal detail') && !r.text.includes('at ');
      return { got: `${r.status} ${clean ? 'no detail' : 'LEAKS'}`, ok: r.status === 500 && clean };
    } finally { await s.close(); }
  }],
  ['Fingerprinting', 'read response headers', 'nosniff, DENY, no-store, no x-powered-by', async () => {
    const s = await boot();
    try {
      const h = (await s.ask('/health')).headers;
      const ok = h['x-content-type-options'] === 'nosniff' && h['x-frame-options'] === 'DENY' && h['cache-control'] === 'no-store' && !h['x-powered-by'] && !h['access-control-allow-origin'];
      return { got: ok ? 'all present' : 'missing', ok };
    } finally { await s.close(); }
  }],
  ['SQL injection', "API key ' OR 1=1 --", '403, never reaches SQL', async () => {
    const s = await boot();
    try { const r = await s.ask('/send?apikey=' + encodeURIComponent("' OR 1=1 --") + '&text=x'); return { got: String(r.status), ok: r.status === 403 }; } finally { await s.close(); }
  }],
  ['Log harvesting', 'bad key in the URL, then read the log', 'apikey=*** in the log', async () => {
    const s = await boot();
    try {
      await s.ask('/send?apikey=Sup3rS3cretGuess&text=x');
      const log = s.lines.join('\n');
      return { got: log.includes('Sup3rS3cretGuess') ? 'secret in log' : 'redacted', ok: !log.includes('Sup3rS3cretGuess') && log.includes('apikey=***') };
    } finally { await s.close(); }
  }],
  ['SSRF loopback', 'image=http://127.0.0.1/health via the API', '400 Destination not allowed', async () => {
    const s = await boot();
    try {
      const key = await signUp(s);
      const r = await s.ask(`/send?apikey=${key}&text=x&image=${encodeURIComponent('http://127.0.0.1/health')}`);
      return { got: `${r.status} ${JSON.parse(r.text).message}`, ok: r.status === 400 && /Destination not allowed/.test(r.text) };
    } finally { await s.close(); }
  }],
  ['SSRF obfuscated IP', 'decimal, hex, octal, IPv4-mapped IPv6, fullwidth dots', 'all rejected', async () => {
    const urls = ['http://2130706433/', 'http://0x7f.1/', 'http://017700000001/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://127。0。0。1/'];
    return rejectedAll(urls);
  }],
  ['SSRF cloud metadata', '169.254.169.254, metadata.google.internal.', 'all rejected', async () => rejectedAll(['http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal./', 'http://[fd00::1]/'])],
  ['SSRF local names', 'localhost., router.local, *.internal', 'all rejected', async () => rejectedAll(['http://localhost./', 'https://router.local/', 'https://db.internal/'])],
  ['SSRF tricks', 'userinfo, odd port, ftp scheme', 'all rejected', async () => rejectedAll(['http://evil@127.0.0.1/', 'https://user:pw@1.2.3.4/', 'https://1.2.3.4:8080/', 'ftp://1.2.3.4/'])],
  ['Memory exhaustion', '100 000 distinct client IPs', 'table stays bounded', async () => {
    const l = createRateLimiter({ maxKeys: 50000 });
    for (let i = 0; i < 100000; i++) l.allow('ip' + i);
    return { got: `${l.size} entries`, ok: l.size <= 50000 };
  }],
  ['Slowloris', 'server timeouts', 'headers <= 15 s, request <= 30 s', async () => {
    const s = await boot();
    try {
      const { headersTimeout, requestTimeout } = s.server;
      return { got: `${headersTimeout / 1000} s / ${requestTimeout / 1000} s`, ok: headersTimeout <= 15000 && requestTimeout <= 30000 };
    } finally { await s.close(); }
  }],
];

async function rejectedAll(urls) {
  let n = 0;
  for (const u of urls) { try { await checkUrl(u, { httpsOnly: false }); } catch (e) { if (e.status === 400) n++; } }
  return { got: `${n}/${urls.length} rejected`, ok: n === urls.length };
}

export async function runAttacks() {
  const results = [];
  for (const [family, attack, expected, fn] of FAMILIES) {
    let r;
    try { r = await fn(); } catch (e) { r = { got: 'error: ' + e.message, ok: false }; }
    results.push({ family, attack, expected, got: r.got, ok: r.ok });
  }
  return results;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderSvg(results) {
  const cols = [['FAMILY', 'family', 24], ['ATTACK', 'attack', 70], ['EXPECTED', 'expected', 50], ['GOT', 'got', 46], ['', 'ok', 4]];
  const cw = 8.4, lh = 24, pad = 24, top = 70;
  const width = Math.round(pad * 2 + cols.reduce((a, c) => a + c[2], 0) * cw);
  const height = top + lh * (results.length + 1) + 50;
  const passed = results.filter((r) => r.ok).length;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14">`,
    `<rect width="100%" height="100%" rx="10" fill="#0f1419"/>`,
    `<circle cx="24" cy="22" r="6" fill="#ff5f56"/><circle cx="44" cy="22" r="6" fill="#ffbd2e"/><circle cx="64" cy="22" r="6" fill="#27c93f"/>`,
    `<text x="${pad}" y="52" fill="#8b949e">$ node attack/attack.mjs</text>`];
  let x = pad;
  for (const [label, , w] of cols) { out.push(`<text x="${x}" y="${top + 8}" fill="#8b949e" font-weight="bold">${label}</text>`); x += w * cw; }
  results.forEach((r, i) => {
    const y = top + lh * (i + 1) + 8;
    if (i % 2 === 0) out.push(`<rect x="${pad - 8}" y="${y - 17}" width="${width - pad * 2 + 16}" height="${lh}" fill="#161b22"/>`);
    let cx = pad;
    for (const [, key, w] of cols) {
      const v = key === 'ok' ? (r.ok ? 'OK' : 'FAIL') : r[key];
      const fill = key === 'ok' ? (r.ok ? '#3fb950' : '#f85149') : key === 'family' ? '#e6edf3' : key === 'got' ? '#79c0ff' : '#c9d1d9';
      out.push(`<text x="${cx}" y="${y}" fill="${fill}"${key === 'ok' || key === 'family' ? ' font-weight="bold"' : ''}>${esc(v)}</text>`);
      cx += w * cw;
    }
  });
  out.push(`<text x="${pad}" y="${height - 20}" fill="${passed === results.length ? '#3fb950' : '#f85149'}" font-weight="bold">${passed}/${results.length} attacks stopped</text>`);
  out.push('</svg>');
  return out.join('\n') + '\n';
}

function printTable(results) {
  const w = [20, 52, 40, 30];
  const pad = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s).padEnd(n));
  console.log(pad('FAMILY', w[0]), pad('ATTACK', w[1]), pad('EXPECTED', w[2]), pad('GOT', w[3]), 'OK');
  for (const r of results) console.log(pad(r.family, w[0]), pad(r.attack, w[1]), pad(r.expected, w[2]), pad(r.got, w[3]), r.ok ? 'OK' : 'FAIL');
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} attacks stopped${failed ? `, ${failed} FAILED` : ''}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2);
  const results = await runAttacks();
  if (args.includes('--json')) console.log(JSON.stringify(results, null, 2));
  else printTable(results);
  const i = args.indexOf('--svg');
  if (i >= 0 && args[i + 1]) fs.writeFileSync(args[i + 1], renderSvg(results));
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}
