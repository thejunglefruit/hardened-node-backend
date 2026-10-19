// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// Calling something that can fail (another API, a messaging service) without letting it drag the server down:
// a time limit on every call, retries with exponential backoff and jitter for errors worth repeating only, and a
// circuit breaker that stops calling whatever has been down for a while.
export class TimeoutError extends Error {
  constructor(ms) { super(`Timed out (${ms} ms)`); this.name = 'TimeoutError'; this.retryable = true; }
}
export class CircuitOpenError extends Error {
  constructor(name, retryInMs) { super(`Circuit "${name}" is open`); this.name = 'CircuitOpenError'; this.retryInMs = retryInMs; }
}

/** Runs `fn(signal)` and cuts it off after `ms`. The AbortSignal lets `fn` really cancel (fetch). */
export async function withTimeout(fn, ms = 10000) {
  const control = new AbortController();
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => { control.abort(); reject(new TimeoutError(ms)); }, ms); });
  try { return await Promise.race([Promise.resolve().then(() => fn(control.signal)), limit]); }
  finally { clearTimeout(timer); }
}

// by default: network failures, timeouts and 408/425/429/5xx are repeated; client errors (other 4xx) are not
export function isRetryable(e) {
  if (e?.permanent) return false;
  if (e?.retryable === true) return true;
  const status = e?.status ?? e?.statusCode ?? e?.response?.status;
  if (status) return status === 408 || status === 425 || status === 429 || status >= 500;
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(e?.code) || e?.name === 'TypeError';
}

/** Wait before attempt `n` + 1 (n = 1, 2, 3…): base·2^(n-1) capped, with "full jitter" (anywhere between 0 and that value). */
export function backoffDelay(n, { baseMs = 200, maxMs = 10000, jitter = true, random = Math.random } = {}) {
  const cap = Math.min(maxMs, baseMs * 2 ** (n - 1));
  return jitter ? Math.floor(random() * cap) : cap;
}

/**
 * Repeats `fn` up to `attempts` times. `budgetMs` is the total time allowed (waits included).
 * Honours Retry-After when the error carries `retryInMs`.
 */
export async function retry(fn, {
  attempts = 4, baseMs = 200, maxMs = 10000, jitter = true, budgetMs = 30000, timeoutMs = 0,
  retryable = isRetryable, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, random = Math.random, onRetry = null,
} = {}) {
  const start = now();
  let last;
  for (let n = 1; n <= attempts; n++) {
    try { return await (timeoutMs ? withTimeout(fn, timeoutMs) : fn(undefined, n)); }
    catch (e) {
      last = e;
      if (n >= attempts || !retryable(e)) throw e;
      const wait = e?.retryInMs ?? backoffDelay(n, { baseMs, maxMs, jitter, random });
      if (now() - start + wait > budgetMs) throw e;
      onRetry?.(e, n, wait);
      await sleep(wait);
    }
  }
  throw last;
}

/**
 * Circuit breaker: closed (calls go through) → open after `threshold` consecutive failures (fails instantly, does not
 * load the service that is down) → half-open after `cooldownMs` (lets ONE probe call through; if it works the circuit
 * closes, if not it opens again).
 */
export function circuitBreaker(name, { threshold = 5, cooldownMs = 30000, countsAsFailure = (e) => !(e?.status >= 400 && e?.status < 500 && e?.status !== 429), now = Date.now, logger = null } = {}) {
  let state = 'closed', failures = 0, openedAt = 0, probing = false;
  const change = (next) => { if (next !== state) { logger?.warn('circuit', { name, from: state, to: next }); state = next; } };

  async function run(fn) {
    if (state === 'open') {
      const left = openedAt + cooldownMs - now();
      if (left > 0) throw new CircuitOpenError(name, left);
      change('half-open');
    }
    if (state === 'half-open') {
      if (probing) throw new CircuitOpenError(name, cooldownMs);
      probing = true;
    }
    try {
      const r = await fn();
      failures = 0; probing = false; change('closed');
      return r;
    } catch (e) {
      if (countsAsFailure(e)) {
        failures++;
        if (state === 'half-open' || failures >= threshold) { openedAt = now(); change('open'); }
      }
      probing = false;
      throw e;
    }
  }
  return { run, get state() { return state; }, get failures() { return failures; }, reset() { failures = 0; probing = false; change('closed'); } };
}
