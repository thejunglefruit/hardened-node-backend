# Resilience: a dedicated box, systemd, a continuous replica and copies off the machine

The deployment half of the kit. It works the same on a dedicated WSL2 distro, a VM or a small VPS (Debian/Ubuntu with systemd). Everything here is free software; nothing needs an account except the optional tunnel.

```
Internet ──► edge (CDN) ──► cloudflared (inside the box, outbound tunnel: no open ports)
                                  │
                                  ▼
                         127.0.0.1:8787  app (node, systemd, user "app", writes only to data/)
                                  │
                                  ▼
                       /opt/app/data/app.sqlite (WAL)
                                  │  ◄── Litestream (every 10 s, 72 h point-in-time)
                                  ▼
                         /var/replica/app (inside the box)
                                  │  ◄── scheduled job: tar out, encrypt, keep the last 14
                                  ▼
                         off-machine copies
Inside ──► app-watchdog.timer: curl /health every minute; 3 failures in a row → systemctl restart app
```

## What survives what

| Incident | What happens | Who fixes it | Data lost |
|---|---|---|---|
| The node process dies (exception, memory cap) | back in ~3 s | `Restart=always` | none |
| Alive but not answering | 3 failed health checks → restart | `app-watchdog.timer` | none |
| The box reboots | services come back on boot | systemd | none (WAL + clean shutdown) |
| Corrupted database | `litestream restore` from the replica, up to 72 h back | by hand | ≤ 10 s |
| The whole box is lost | rebuild, restore from the off-machine copy | by hand | ≤ copy interval |
| Network / edge down | the local API keeps working; the tunnel reconnects | cloudflared | none |

## Files

| File | Purpose |
|---|---|
| `wsl.conf` | For a WSL2 box: systemd on, Windows drives and interop off, non-root default user. |
| `install_tools.sh` | Node LTS, Litestream and cloudflared, each with its SHA256 checked; unattended security upgrades. |
| `install_services.sh` | Creates the `app` user and folders, installs the units, enables app + litestream + watchdog (cloudflared stays off). |
| `systemd/app.service` | The app with hardening: `NoNewPrivileges`, `ProtectSystem=strict`, write access only to `data/`, `MemoryMax`. |
| `systemd/litestream.service`, `litestream.yml` | Continuous file replica; S3-compatible block commented, credentials from an env file. |
| `systemd/cloudflared.service`, `cloudflared.example.yml` | Outbound tunnel; placeholder hostname and UUID. |
| `systemd/watchdog.sh`, `app-watchdog.{service,timer}` | Health check every minute. |

## Set up

```sh
# inside the box, as root, with this folder copied in
bash install_tools.sh
bash install_services.sh
# deploy the code to /opt/app (tar stream, npm ci --omit=dev), then:
systemctl start app litestream
curl -s http://127.0.0.1:8787/health
```

On WSL, create the distro with `wsl --install <distro> --name <name> --location <folder> --no-launch`, write `wsl.conf` into `/etc/wsl.conf`, `wsl --terminate <name>`, and check that `/mnt` is empty. WSL shuts a distro down a few seconds after its last session closes, even with systemd running: keep it alive with a scheduled task that runs `wsl -d <name> --exec sleep infinity` at log-on and restarts it if it stops.

## Restore

```sh
systemctl stop app litestream
cd /opt/app/data && rm -f app.sqlite app.sqlite-wal app.sqlite-shm
litestream restore -config /etc/litestream.yml -o app.sqlite /opt/app/data/app.sqlite
chown app:app app.sqlite* && systemctl start app litestream
```
Add `-timestamp <ISO time>` for a point in time; from an off-machine copy use a `file:///path/to/replica` URL. Always rehearse into `/tmp` first and run `sqlite3 /tmp/x.sqlite 'PRAGMA integrity_check'`.

## Encrypted copies

Encrypt **inside** the box so only ciphertext leaves it, e.g. `tar -C /var/replica -cf - app | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_KEY`. Pass the passphrase through an environment variable, never on the command line, and keep a copy of it in a password manager: if the box is lost and the passphrase lived only inside it, the backups are unreadable.

## Lessons learnt

- Litestream's `.deb` installs a fully commented `/etc/litestream.yml`; `install_services.sh` replaces it once and then respects manual edits.
- Run commands into WSL with `--exec`: without it, the login shell expands `$(...)` in the wrong place.
- A text pipe from Windows PowerShell 5.1 corrupts tar streams and adds a BOM; pipe bytes between processes directly.
