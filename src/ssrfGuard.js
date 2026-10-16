// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// SSRF guard: before the server downloads a URL supplied by a user (an image, a document, a webhook target) check
// that it does not point inside: localhost, the LAN, the router, a cloud metadata service (169.254.169.254)...
// and that it is neither huge nor endless.
// To defeat DNS rebinding (resolve a good IP, then connect to another one), the connection goes to the IP that
// was checked, and the name is only passed as the Host header / SNI.
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { HttpError } from './errors.js';

const FORBIDDEN_NAMES = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home|.*\.lan|.*\.arpa|metadata\.google\.internal)$/i;

function privateIpv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

export function isPrivateIp(ip) {
  ip = String(ip).trim().toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  if (ip.startsWith('::ffff:')) return isPrivateIp(ip.slice(7));
  if (net.isIPv4(ip)) return privateIpv4(ip);
  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1') return true;
    if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true; // link-local
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // unique local
    if (ip.startsWith('ff')) return true; // multicast
    if (ip.startsWith('2002:') || ip.startsWith('64:ff9b:')) return true; // 6to4 / NAT64 can hide private IPv4
    return false;
  }
  return true; // not an IP: do not trust it
}

/** Checks a URL without connecting: scheme, name, port, then resolves DNS. Returns { url, ip, port }. */
export async function checkUrl(input, { httpsOnly = true, ports = null, skipDns = false } = {}) {
  let url;
  try { url = new URL(String(input)); } catch { throw new HttpError(400, 'Invalid URL'); }
  const schemes = httpsOnly ? ['https:'] : ['https:', 'http:'];
  if (!schemes.includes(url.protocol)) throw new HttpError(400, httpsOnly ? 'Only https URLs are allowed' : 'Only http(s) URLs are allowed');
  if (url.username || url.password) throw new HttpError(400, 'URLs with credentials are not allowed');
  const allowedPorts = ports || (httpsOnly ? [443] : [80, 443]);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!allowedPorts.includes(port)) throw new HttpError(400, 'Port not allowed');
  // strip the FQDN trailing dot ("localhost." is "localhost"), otherwise it would slip past the name list
  const name = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (FORBIDDEN_NAMES.test(name)) throw new HttpError(400, 'Destination not allowed');
  let ip;
  if (net.isIP(name)) ip = name;
  else if (skipDns) return { url, ip: null, port }; // quick check (syntax, names, literal IPs); DNS is checked at download time
  else {
    let addresses;
    try { addresses = await dns.lookup(name, { all: true, verbatim: true }); } catch { throw new HttpError(400, 'Name does not resolve'); }
    if (!addresses.length) throw new HttpError(400, 'Name does not resolve');
    // if ANY of the addresses is private, reject (an attacker can mix a public and a private one)
    if (addresses.some((d) => isPrivateIp(d.address))) throw new HttpError(400, 'Destination not allowed');
    ip = addresses[0].address;
  }
  if (isPrivateIp(ip)) throw new HttpError(400, 'Destination not allowed');
  return { url, ip, port };
}

/**
 * Safe download: checks the URL, connects to the checked IP, caps size and time, follows at most `maxRedirects`
 * (each one checked again) and requires a content type from the list.
 * Returns { body: Buffer, type, bytes, finalUrl }.
 */
export async function safeFetch(input, {
  maxBytes = 10 * 1024 * 1024, timeoutMs = 10000, maxRedirects = 3, types = null, httpsOnly = true, ports = null, method = 'GET', headers = {},
} = {}) {
  let current = input;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { url, ip, port } = await checkUrl(current, { httpsOnly, ports });
    const result = await new Promise((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const request = mod.request({
        host: ip, port, servername: url.hostname, method, path: url.pathname + url.search,
        headers: { host: url.host, 'user-agent': 'hardened-node-backend/1', accept: '*/*', ...headers },
        timeout: timeoutMs,
        // the IP is already decided: lookup always returns the checked one (no DNS change between check and connect)
        lookup: (_name, options, cb) => {
          const family = net.isIPv6(ip) ? 6 : 4;
          if (options?.all) return cb(null, [{ address: ip, family }]);
          cb(null, ip, family);
        },
      }, (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          const target = res.headers.location;
          if (!target) return reject(new HttpError(400, 'Redirect without a location'));
          return resolve({ redirect: new URL(target, url).href });
        }
        if (status < 200 || status >= 300) { res.resume(); return reject(new HttpError(400, `Remote server answered ${status}`)); }
        const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (types && !types.some((t) => (t.endsWith('/*') ? type.startsWith(t.slice(0, -1)) : type === t))) { res.resume(); return reject(new HttpError(400, 'Content type not allowed')); }
        const announced = Number(res.headers['content-length'] || 0);
        if (announced > maxBytes) { res.resume(); return reject(new HttpError(413, 'File too large')); }
        const chunks = []; let bytes = 0;
        res.on('data', (d) => {
          bytes += d.length;
          if (bytes > maxBytes) { request.destroy(new HttpError(413, 'File too large')); return; }
          chunks.push(d);
        });
        res.on('end', () => resolve({ body: Buffer.concat(chunks), type, bytes, finalUrl: url.href }));
        res.on('error', reject);
      });
      request.on('timeout', () => request.destroy(new HttpError(400, 'Remote server is too slow')));
      request.on('error', (e) => reject(e instanceof HttpError ? e : new HttpError(400, 'Download failed')));
      request.end();
    });
    if (result.redirect) { current = result.redirect; continue; }
    return result;
  }
  throw new HttpError(400, 'Too many redirects');
}
