#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 The Jungle Fruit
# /usr/local/bin/app-watchdog.sh — run every minute by app-watchdog.timer.
# systemd already restarts the process if it DIES; this covers the other case: the process is alive but does not
# answer (blocked event loop, hung socket). Three failures in a row -> restart and a line in the log.
set -u
URL="${URL:-http://127.0.0.1:8787/health}"
SERVICE="${SERVICE:-app}"
LOG="${LOG:-/var/log/app-watchdog.log}"
MAX_FAILURES="${MAX_FAILURES:-3}"
# Counter in /run: wiped on reboot, so old failures are not carried over.
COUNTER="/run/${SERVICE}-watchdog.failures"

now() { date '+%Y-%m-%d %H:%M:%S'; }
failures=$(cat "$COUNTER" 2>/dev/null || echo 0)

if curl -fsS --max-time 5 "$URL" >/dev/null 2>&1; then
  if [ "$failures" -gt 0 ]; then echo "$(now) recovered after $failures failure(s)" >> "$LOG"; fi
  echo 0 > "$COUNTER"
  exit 0
fi

failures=$((failures + 1))
echo "$failures" > "$COUNTER"
echo "$(now) failure $failures/$MAX_FAILURES on $URL (service: $(systemctl is-active "$SERVICE"))" >> "$LOG"

if [ "$failures" -ge "$MAX_FAILURES" ]; then
  echo "$(now) RESTART of $SERVICE after $failures failures in a row" >> "$LOG"
  systemctl restart "$SERVICE"
  echo 0 > "$COUNTER"
fi
