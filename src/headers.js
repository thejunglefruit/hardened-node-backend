// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// Security headers for an API (not for an HTML site): no CORS, no framing, no caching.
export function securityHeaders({ behindTunnel = false, csp = "default-src 'none'; frame-ancestors 'none'" } = {}) {
  const h = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'content-security-policy': csp,
    'cross-origin-resource-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
  // HSTS only makes sense when clients arrive over HTTPS (at the tunnel's edge)
  if (behindTunnel) h['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

export function applyHeaders(res, options) {
  for (const [k, v] of Object.entries(securityHeaders(options))) res.setHeader(k, v);
  // do not advertise what runs behind
  res.removeHeader('x-powered-by');
}
