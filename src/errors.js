// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// Errors with an HTTP status and a fixed message. Anything else (a bug, a disk failure, an unexpected exception)
// goes out as a plain 500 "Internal error": the detail goes to the log, never to the client, because an attacker
// learns from error messages.
export class HttpError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export const badRequest = (message = 'Bad request') => new HttpError(400, message);
export const forbidden = (message = 'Forbidden') => new HttpError(403, message);
export const notFound = (message = 'Not found') => new HttpError(404, message);
export const tooLarge = (message = 'Payload too large') => new HttpError(413, message);
export const tooManyRequests = (retryAfter = 1, message = 'Too many requests') => new HttpError(429, message, { retryAfter });

export function sendError(res, e, logger, { json = false } = {}) {
  const known = e instanceof HttpError;
  const status = known ? e.status : 500;
  const message = known ? e.message : 'Internal error';
  if (!known) logger?.error('exception', { error: e });
  else if (status >= 500) logger?.error('http_error', { status, message });
  if (res.headersSent) { try { res.end(); } catch { /* nothing left to do */ } return; }
  const headers = { 'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8' };
  if (status === 429 && e.data?.retryAfter) headers['retry-after'] = String(e.data.retryAfter);
  res.writeHead(status, headers);
  res.end(json ? JSON.stringify({ ok: false, message }) : message);
}
