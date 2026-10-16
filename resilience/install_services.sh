#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 The Jungle Fruit
# Installs, as root inside the box, the systemd units and configs from this folder. Run after install_tools.sh.
# Idempotent: run it again to update the units.
#   APP_USER=app APP_DIR=/opt/app REPLICA_DIR=/var/replica/app bash install_services.sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
APP_USER="${APP_USER:-app}"
APP_DIR="${APP_DIR:-/opt/app}"
REPLICA_DIR="${REPLICA_DIR:-/var/replica/app}"

id "$APP_USER" >/dev/null 2>&1 || useradd -m -s /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_DIR" "$APP_DIR/data" "$REPLICA_DIR"
install -d -m 755 /etc/cloudflared

echo "== systemd units"
install -m 644 "$HERE/systemd/app.service" "$HERE/systemd/litestream.service" "$HERE/systemd/cloudflared.service" \
  "$HERE/systemd/app-watchdog.service" "$HERE/systemd/app-watchdog.timer" /etc/systemd/system/
install -m 755 "$HERE/systemd/watchdog.sh" /usr/local/bin/app-watchdog.sh
# litestream.yml: the .deb leaves a fully commented default. Replace it the first time (keeping a .deb copy);
# afterwards only overwrite it if nobody edited it by hand (identical to the .kit copy).
if [ ! -f /etc/litestream.yml.kit ]; then
  [ -f /etc/litestream.yml ] && cp /etc/litestream.yml /etc/litestream.yml.deb
  install -m 644 "$HERE/litestream.yml" /etc/litestream.yml
elif cmp -s /etc/litestream.yml /etc/litestream.yml.kit; then
  install -m 644 "$HERE/litestream.yml" /etc/litestream.yml
else
  echo "NOTE: /etc/litestream.yml was edited by hand; left alone (the kit's version is in /etc/litestream.yml.kit)"
fi
cp "$HERE/litestream.yml" /etc/litestream.yml.kit
install -m 644 "$HERE/cloudflared.example.yml" /etc/cloudflared/config.example.yml
touch /var/log/app-watchdog.log

systemctl daemon-reload
# cloudflared stays disabled until the tunnel exists.
systemctl disable cloudflared >/dev/null 2>&1 || true
systemctl enable app litestream app-watchdog.timer >/dev/null
systemctl start app-watchdog.timer
# app and litestream start with the first deployment (otherwise systemd would retry them in a loop with no code).
systemctl list-unit-files 'app*' 'litestream*' 'cloudflared*' --no-legend
echo "== done (app and litestream start with the first deployment)"
