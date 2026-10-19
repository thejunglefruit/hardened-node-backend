// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// Request id: every request carries an id (the caller's `x-request-id` if it looks sane, otherwise a new one) that is
// returned in the response and added to every log line, so one request can be followed end to end.
// A light version of distributed tracing: it works across your own services if you forward the header on outgoing calls.
import crypto from 'node:crypto';

const VALID = /^[A-Za-z0-9._-]{8,64}$/;

export function requestId(req) {
  const incoming = req.headers['x-request-id'];
  return typeof incoming === 'string' && VALID.test(incoming) ? incoming : crypto.randomUUID();
}

/** Puts the id on the response and returns a "child" logger that adds it to everything it writes. */
export function withTrace(req, res, logger) {
  const id = requestId(req);
  res.setHeader('x-request-id', id);
  const child = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((n) => [n, (event, data) => logger[n](event, { id, ...(data || {}) })]));
  return { id, logger: { ...logger, ...child }, headers: { 'x-request-id': id } };
}
