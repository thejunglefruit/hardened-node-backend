// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// harden(server, options): sets the server's timeouts and returns `wrap(handler)`, which sends every request
// through the same funnel: short URL, own Origin or none, per-IP limit, security headers, bounded body and clean
// errors. The handler receives (req, res, ctx) with ctx = { ip, logger, url, params, readBody, failures }.
import { clientIp } from './clientIp.js';
import { createRateLimiter, createFailureCounter } from './rateLimit.js';
import { applyHeaders } from './headers.js';
import { createLogger } from './logger.js';
import { HttpError, sendError, tooLarge, tooManyRequests, forbidden, badRequest } from './errors.js';

export * from './clientIp.js';
export * from './rateLimit.js';
export * from './headers.js';
export * from './apiKeys.js';
export * from './logger.js';
export * from './errors.js';
export * from './ssrfGuard.js';
export * from './persistentQueue.js';
export * from './shutdown.js';

export function harden(server, {
  ownOrigin = null,              // e.g. 'https://api.example.com'; when null, NO Origin header is accepted
  behindTunnel = false,
  logger = createLogger({ console: true }),
  rateLimit = { capacity: 60, perSecond: 1 },      // per IP
  failures = { maxFailures: 20, windowMs: 600000, blockMs: 900000 },
  maxUrl = 2048,
  maxBody = 100 * 1024,
  json = false,                  // error format
  exempt = [],                   // IPs without limits (e.g. a local health checker)
  // Read-only routes that your own website may call from the browser (e.g. a status page):
  // { '/health': ['https://www.example.com'] }. GET/HEAD/OPTIONS only, those exact origins only; everything else stays without CORS.
  publicRoutes = {},
} = {}) {
  // timeouts: a deliberately slow connection (slowloris) cannot hang around
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;

  const limiter = createRateLimiter(rateLimit);
  const failureCounter = createFailureCounter(failures);
  const exemptIps = new Set(exempt);

  // raw: returns the text as is (needed to verify webhook signatures)
  async function readBody(req, max = maxBody, { raw = false } = {}) {
    const chunks = []; let bytes = 0, exceeded = false;
    for await (const c of req) {
      bytes += c.length;
      if (bytes > max) {
        // drain what arrives (up to 4x the cap) so a clean 413 can be sent; beyond that, cut the connection
        exceeded = true;
        if (bytes > max * 4) { req.destroy(); break; }
        continue;
      }
      chunks.push(c);
    }
    if (exceeded) throw tooLarge('Body too large');
    const data = Buffer.concat(chunks).toString('utf8');
    if (raw) return data;
    if (!data) return {};
    const type = String(req.headers['content-type'] || '');
    if (type.includes('json')) {
      try { const v = JSON.parse(data); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { throw badRequest('Invalid JSON'); }
    }
    return Object.fromEntries(new URLSearchParams(data));
  }

  function wrap(handler) {
    return async (req, res) => {
      const ip = clientIp(req, { behindTunnel });
      const ctx = { ip, logger, readBody: (max, options) => readBody(req, max, options), failures: failureCounter };
      try {
        applyHeaders(res, { behindTunnel });
        if (!req.url || req.url.length > maxUrl) throw new HttpError(414, 'URL too long');
        const origin = req.headers.origin;
        const route = (req.url.split('?')[0] || '/').replace(/\/+$/, '') || '/';
        const open = origin !== undefined && Object.hasOwn(publicRoutes, route) && publicRoutes[route].includes(origin) && ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
        if (origin !== undefined && !open && (ownOrigin === null || origin !== ownOrigin)) throw forbidden('Origin not allowed');
        if (open) {
          // minimal CORS for that route and that origin: no credentials, no extra headers
          res.setHeader('access-control-allow-origin', origin);
          res.setHeader('vary', 'Origin');
          res.setHeader('cross-origin-resource-policy', 'cross-origin');
          if (req.method === 'OPTIONS') {
            res.setHeader('access-control-allow-methods', 'GET, HEAD');
            res.setHeader('access-control-max-age', '600');
            res.writeHead(204); res.end(); return;
          }
        }
        if (!exemptIps.has(ip)) {
          const block = failureCounter.blocked(ip);
          if (block) throw tooManyRequests(block, 'Too many failed attempts, wait a while');
          const p = limiter.allow(ip);
          if (!p.ok) throw tooManyRequests(p.retryAfter);
        }
        ctx.url = new URL(req.url, 'http://local');
        ctx.params = Object.fromEntries(ctx.url.searchParams);
        await handler(req, res, ctx);
      } catch (e) {
        sendError(res, e, logger, { json });
      }
    };
  }

  return { wrap, readBody, limiter, failures: failureCounter, logger };
}
