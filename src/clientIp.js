// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// The client's real IP. Behind a tunnel (e.g. cloudflared) every connection arrives from 127.0.0.1 and the real
// address travels in a header. Those headers are ONLY trusted when `behindTunnel` is on AND the direct connection
// is local; otherwise anyone could invent an IP and dodge the per-IP limits.
import net from 'node:net';

const LOCAL = new Set(['127.0.0.1', '::1']);

export function normalizeIp(ip) {
  ip = String(ip || '').trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

export function clientIp(req, { behindTunnel = false } = {}) {
  const direct = normalizeIp(req.socket?.remoteAddress);
  if (!behindTunnel || !LOCAL.has(direct)) return direct;
  const cf = req.headers['cf-connecting-ip'];
  if (cf && net.isIP(normalizeIp(cf))) return normalizeIp(cf);
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = normalizeIp(String(xff).split(',')[0]);
    if (net.isIP(first)) return first;
  }
  return direct;
}
