// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 The Jungle Fruit
// Graceful shutdown and uncaught errors. With a supervisor (systemd, a scheduled task) restarting the process,
// the safe answer to an unknown error is to log it and EXIT: a half-broken process that keeps accepting requests
// is worse than one that restarts clean in two seconds.
export function installShutdown({ server = null, logger = null, onClose = [], timeoutMs = 10000 } = {}) {
  let closing = false;

  async function close(reason, code) {
    if (closing) return;
    closing = true;
    logger?.info('shutting_down', { reason });
    const deadline = setTimeout(() => { logger?.warn('forced_shutdown', { reason }); process.exit(code); }, timeoutMs);
    deadline.unref();
    try {
      if (server) await new Promise((r) => server.close(() => r()));
      for (const fn of onClose) { try { await fn(); } catch (e) { logger?.error('close_error', { error: e }); } }
    } finally {
      process.exit(code);
    }
  }

  process.on('SIGINT', () => close('SIGINT', 0));
  process.on('SIGTERM', () => close('SIGTERM', 0));
  process.on('uncaughtException', (e) => { logger?.error('uncaughtException', { error: e }); close('uncaughtException', 1); });
  process.on('unhandledRejection', (e) => { logger?.error('unhandledRejection', { error: e instanceof Error ? e : new Error(String(e)) }); close('unhandledRejection', 1); });

  return { close };
}
