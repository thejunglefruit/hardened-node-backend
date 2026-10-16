# Security guide: the layers, from the edge to the backup

"Unhackable" does not exist. What does exist: make attacking cost more than it pays, make every failure do little damage, find out fast and recover in minutes. This guide walks through the layers a small self-hosted API goes through and what each one stops.

```
client ──► 1. edge (CDN / WAF, DDoS absorption, your home IP hidden)
              │ outbound encrypted tunnel: no open ports on the router
           2. tunnel connector (cloudflared or similar) inside the box
              │ 127.0.0.1:<port>
           3. isolated box: a dedicated Linux distro / VM / VPS, no host disks mounted
              └─ 4. the app, wrapped by harden():
                     short URL → Origin → real IP → per-IP bucket → failed-key block
                     → headers → bounded body → route
                       ├─ API key → peppered hash → user
                       ├─ user URL → checkUrl / safeFetch (never your LAN)
                       └─ persistent queue (SQLite) → outgoing work
           5. supervisor: systemd restarts it, a watchdog checks health, Litestream replicates the DB
           6. copies off the box, encrypted
           7. alerts to you when something goes wrong
```

If one layer fails, the next one is still there.

## 1. The edge

A CDN in front absorbs floods, runs managed WAF rules against known exploits and hides your origin's address. Free plans are enough for volumetric attacks; fine-grained bot detection is paid, which is why per-IP limits live in the app too. Keep the emergency switches in mind: "under attack" challenge mode, custom block rules (country, IP, pattern) and one rate-limit rule.

The tunnel connector opens an **outbound** connection to the edge. Nothing listens on the internet, so there is nothing to scan. A second connector on another machine with the same tunnel is the cheapest real fallback.

## 2. The isolated box

Run the app in a box made only for it: a dedicated WSL distro, VM or VPS with
- **no host disks mounted** (if someone gets in through the app, your files are not there);
- no interop with the host;
- an unprivileged service user; root only to install;
- systemd to restart it.

Code goes in by a tar stream; data comes out the same way. No shared folder is a path back.

## 3. The funnel in the code (`src/`)

Every request goes through `harden()` in this order, and each step has a test that attacks it:

- **URL and Origin.** URLs over 2 KB → 414. A request carrying an `Origin` header that is not yours (including `null`) → 403. No CORS, except exact read-only routes you list in `publicRoutes`.
- **Real IP and limits.** The client-IP header is trusted only when `behindTunnel` is on and the direct connection is local. A token bucket per IP (60 at once, then 1/s) answers 429 with `Retry-After`. 20 bad keys from one IP in 10 minutes block that IP for 15 minutes, even if it then guesses right. Tables evict old entries, so millions of IPs cannot fill memory.
- **Headers and body.** `nosniff`, `DENY`, `no-store`, a minimal CSP, no `X-Powered-By`. Body ≤ 100 KB (413; the connection is cut if someone keeps pushing). Broken JSON → 400. Server timeouts stop slowloris.
- **API keys.** 128 random bits, never stored: only `sha256(pepper + key)` and an 8-character prefix for lookup. A stolen database holds fingerprints, not keys, and without the pepper they cannot even be tested. Comparison is constant-time. The key is shown once; a lost key is replaced, not recovered.
- **SSRF.** A user URL that your server will open is checked twice: syntax on arrival (scheme, port, credentials, internal names) and, at download time, DNS resolution with **every** address checked against private ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16 cloud metadata, ::1, fe80::/10, fc00::/7, mapped and 6to4 forms). The connection then goes to the checked IP, with caps on size, time and redirects (each redirect re-checked).
- **Errors and logs.** Unknown errors return `500 Internal error`; the stack goes to the log. The log is one JSON line per event, redacts keys, tokens, passwords and the middle of phone numbers, and rotates at 5 MB × 5.
- **Persistent queue.** Work is written to SQLite before the API answers. If the process dies, it is still there. Retries back off exponentially; the queue has a cap and answers 429 when full.
- **Graceful shutdown.** On SIGTERM: stop accepting, finish, close the database. On an unexpected error: log and **exit**, the supervisor restarts it clean.

## 4. Staying up, and coming back

- `systemd` with `Restart=always` and a hardened unit: no new privileges, read-only filesystem except the data folder, memory cap, private `/tmp`.
- A watchdog timer calls the health route every minute; three failures in a row restart the service.
- Litestream streams every SQLite change to a replica; the worst-case loss is seconds.
- A scheduled job copies the replica off the box, encrypted, keeping the last N.

## 5. Knowing something is wrong

Send yourself alerts for: the queue filling up, a burst of sign-ups, the upstream service down, IPs blocked for bad keys. Add an external uptime monitor: from inside you cannot know the internet cannot reach you. Signs of an attack in the log: many `auth_failed` from one IP, many 429, `Destination not allowed` (someone probing SSRF).

## 6. The account that unlocks everything

However hardened the server is, whoever gets into the email used for the edge, the registrar, the code host and the payment provider can recover all of them. Use a dedicated mailbox per product, app-based 2FA everywhere, recovery codes in a password manager and never in a project folder.

## 7. What this does not cover

- One machine is one point of failure until there is a second connector.
- Personal data you must keep in clear (e.g. phone numbers to deliver to) stays readable to whoever steals the database: minimise and encrypt the copies.
- Own tests and free scanners are not an external audit.
- Free edge plans do not stop sophisticated bots.
