// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// Minimal server using the whole kit. It is the reference for applying it to an app and the target of the attack battery.
//   node examples/server.js          -> listens on 127.0.0.1:8787
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  harden, generateKey, hashKey, keyPrefix, compareHash, isValidKeyShape, forbidden, badRequest,
  createPersistentQueue, safeFetch, createLogger, installShutdown,
} from '../src/index.js';

export function createExampleServer({
  ownOrigin = 'https://api.example.test', behindTunnel = false, rateLimit, failures, pepper = 'test-pepper',
  process: handle = async () => {}, logger = createLogger({ console: false }), dbPath = ':memory:',
} = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, prefix TEXT, hash TEXT)');
  const server = http.createServer();
  const { wrap } = harden(server, { ownOrigin, behindTunnel, logger, rateLimit, failures, json: true, publicRoutes: { '/health': ['https://www.example.test'] } });
  const queue = createPersistentQueue({ db, channel: 'example', process: handle, max: 5, logger });
  queue.start();

  // sign-up: creates a key and returns it, the only time it is ever seen in clear
  const signUp = () => { const k = generateKey(); db.prepare('INSERT INTO users (prefix, hash) VALUES (?, ?)').run(keyPrefix(k), hashKey(k, pepper)); return k; };
  const findUser = (key) => {
    if (!isValidKeyShape(key)) return null;
    const u = db.prepare('SELECT * FROM users WHERE prefix = ?').get(keyPrefix(key));
    return u && compareHash(u.hash, hashKey(key, pepper)) ? u : null;
  };

  server.on('request', wrap(async (req, res, ctx) => {
    const params = { ...ctx.params, ...(req.method === 'POST' ? await ctx.readBody() : {}) };
    const route = ctx.url.pathname;
    const ok = (body) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    if (route === '/signup') return ok({ apikey: signUp() });
    if (route === '/health') return ok({ ok: true });
    if (route === '/send') {
      const u = findUser(params.apikey ?? req.headers['x-api-key']);
      if (!u) {
        ctx.failures.fail(ctx.ip);
        ctx.logger.warn('auth_failed', { ip: ctx.ip, url: req.url }); // the logger redacts apikey=... from the URL
        throw forbidden('Invalid API key');
      }
      ctx.failures.success(ctx.ip);
      if (!params.text) throw badRequest('Missing text');
      if (params.image) await safeFetch(params.image, { httpsOnly: false, types: ['image/*'] });
      const id = queue.push({ user: u.id, text: params.text });
      return ok({ ok: true, id });
    }
    if (route === '/crash') throw new Error('internal detail that must never leak ' + params.apikey);
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found');
  }));
  return { server, queue, db, logger };
}

// run directly: a local demo server
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const logger = createLogger({ console: true });
  const { server, queue } = createExampleServer({ logger, process: async (job) => logger.info('job_done', job) });
  server.listen(8787, '127.0.0.1', () => logger.info('listening', { url: 'http://127.0.0.1:8787' }));
  installShutdown({ server, logger, onClose: [() => queue.stop()] });
}
