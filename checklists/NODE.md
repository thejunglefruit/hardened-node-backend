# Checklist: applying the kit to a new Node app

About ten minutes for a small `node:http` service. Nothing here costs money.

1. **Copy `src/`** into the app (e.g. `src/hardening/`) with a short note saying where it came from and which version.
2. **Wrap the server** (see `examples/server.js`):
   ```js
   const server = http.createServer();
   const { wrap } = harden(server, { ownOrigin: 'https://api.example.com', behindTunnel: true, logger, json: true });
   server.on('request', wrap(async (req, res, ctx) => { /* ctx.ip, ctx.params, await ctx.readBody(), ctx.failures */ }));
   ```
3. **Keys**: store `hashKey(key, pepper)` + `keyPrefix(key)`, look up by prefix, compare with `compareHash`. Show the key once. Record `ctx.failures.fail(ctx.ip)` on every bad key and `success` on a good one.
4. **Any URL a user gives you that the server will open**: `checkUrl()` on arrival, `safeFetch()` when used. Never `fetch(userUrl)`.
5. **Work that must not be lost** (outgoing messages, emails, webhooks): `createPersistentQueue()` with a cap.
6. **`installShutdown()`** at the end of start-up; a supervisor (systemd, a scheduled task) restarts the process.
7. **Copy the tests**: one test per protection, each written as the attack it stops.
8. **Run the attack battery** (`attack/attack.mjs`) against your own server factory. Every failure is fixed with a regression test, then re-run until zero failures. Write down the residual risks honestly.
9. **Dependencies and secrets**: `npm audit`, a lockfile, no secrets or personal names in the repo (`gitleaks` or `trufflehog` once, `.env` in `.gitignore`).
10. **Deploy** following `resilience/README.md` (dedicated Linux user, systemd, continuous SQLite replica, encrypted off-machine copies, outbound tunnel).
11. **Fill in** `docs/THREAT_MODEL.md` for the app and keep `docs/INCIDENT_PLAYBOOK.md` at hand.

## Before going public

- [ ] `behindTunnel: true` once a tunnel or reverse proxy is in front (otherwise every client looks like 127.0.0.1 and one block blocks everyone).
- [ ] `httpsOnly: true` for `checkUrl` / `safeFetch` in production.
- [ ] API keys accepted in a header (e.g. `X-Api-Key`), not only in the query string: URLs end up in proxy logs.
- [ ] Config file and data directory with `chmod 600` / `700`, owned by the service user.
- [ ] A restore drill done and timed (RPO / RTO written down).
- [ ] An external uptime monitor on the health route.
