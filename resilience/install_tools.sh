#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 The Jungle Fruit
# Installs, as root inside the box (Debian/Ubuntu x86-64): Node LTS, Litestream, cloudflared and automatic
# security updates. A download is never piped straight into a shell: every file is saved, its SHA256 is checked against what the
# publisher lists, and only then installed.
#
# Optional pins: NODE_VERSION=v24.x.y LITESTREAM_VERSION=0.5.x CLOUDFLARED_VERSION=YYYY.M.N
# (empty = latest v24 LTS / latest release).
# No pipefail on purpose: "head -1" in the filters would kill the previous grep with SIGPIPE.
# What must fail loudly (sha256sum -c, dpkg, tar) already does with set -e.
set -eu
export DEBIAN_FRONTEND=noninteractive

TMP=$(mktemp -d /tmp/tools.XXXXXX)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
ARCH=x64
echo "== base packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git sqlite3 unattended-upgrades xz-utils >/dev/null

# ---------- Node LTS (official tar.xz, checked against SHASUMS256.txt) ----------
if [ -z "${NODE_VERSION:-}" ]; then
  curl -fsSL https://nodejs.org/dist/index.json -o index.json
  NODE_VERSION=$(grep -o '{"version":"v24\.[^}]*}' index.json | grep -v '"lts":false' | head -1 | sed 's/{"version":"\([^"]*\)".*/\1/')
fi
[ -n "$NODE_VERSION" ] || { echo "ERROR: no Node version"; exit 1; }
echo "== Node $NODE_VERSION"
NODE_TAR="node-$NODE_VERSION-linux-$ARCH.tar.xz"
curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/$NODE_TAR"
curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
grep " $NODE_TAR\$" SHASUMS256.txt | sha256sum -c -
tar -xJf "$NODE_TAR" -C /usr/local --strip-components=1 --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md
echo "node $(/usr/local/bin/node -v)  npm $(/usr/local/bin/npm -v)"

# ---------- Litestream (.deb, checked against the release's checksums.txt) ----------
if [ -z "${LITESTREAM_VERSION:-}" ]; then
  curl -fsSL https://api.github.com/repos/benbjohnson/litestream/releases/latest -o litestream.json
  LITESTREAM_VERSION=$(grep -o '"tag_name": *"v[^"]*"' litestream.json | head -1 | sed 's/.*"v\([^"]*\)"/\1/')
fi
[ -n "$LITESTREAM_VERSION" ] || { echo "ERROR: no Litestream version"; exit 1; }
echo "== Litestream $LITESTREAM_VERSION"
LS_DEB="litestream-$LITESTREAM_VERSION-linux-x86_64.deb"
LS_URL="https://github.com/benbjohnson/litestream/releases/download/v$LITESTREAM_VERSION"
curl -fsSLO "$LS_URL/$LS_DEB"
curl -fsSLO "$LS_URL/checksums.txt"
grep " $LS_DEB\$" checksums.txt | sha256sum -c -
dpkg -i "$LS_DEB" >/dev/null
# The .deb ships its own unit; keep it off until install_services.sh puts the real config in place.
systemctl disable --now litestream >/dev/null 2>&1 || true
echo "litestream $(litestream version)"

# ---------- cloudflared (.deb, SHA256 published in the release notes) ----------
if [ -z "${CLOUDFLARED_VERSION:-}" ]; then
  curl -fsSL https://api.github.com/repos/cloudflare/cloudflared/releases/latest -o cloudflared.json
  CLOUDFLARED_VERSION=$(grep -o '"tag_name": *"[^"]*"' cloudflared.json | head -1 | sed 's/.*: *"\([^"]*\)"/\1/')
else
  curl -fsSL "https://api.github.com/repos/cloudflare/cloudflared/releases/tags/$CLOUDFLARED_VERSION" -o cloudflared.json
fi
[ -n "$CLOUDFLARED_VERSION" ] || { echo "ERROR: no cloudflared version"; exit 1; }
echo "== cloudflared $CLOUDFLARED_VERSION"
CF_DEB="cloudflared-linux-amd64.deb"
curl -fsSLo "$CF_DEB" "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/$CF_DEB"
CF_SHA=$(grep -o "$CF_DEB: [0-9a-f]\{64\}" cloudflared.json | head -1 | cut -d' ' -f2)
if [ -z "$CF_SHA" ]; then echo "ERROR: no SHA256 for $CF_DEB in the $CLOUDFLARED_VERSION release notes"; exit 1; fi
echo "$CF_SHA  $CF_DEB" | sha256sum -c -
dpkg -i "$CF_DEB" >/dev/null
echo "cloudflared $(cloudflared --version)"

# ---------- Automatic security updates ----------
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
systemctl enable apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true

echo "== SHA256 verified"
sha256sum "$NODE_TAR" "$LS_DEB" "$CF_DEB"
echo "== done"
