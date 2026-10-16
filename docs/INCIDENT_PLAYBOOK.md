# Incident playbook

Written to be followed alone, at night, without thinking much. It assumes the deployment in `resilience/`: a service called `app` under systemd, data in `/opt/app/data`, a Litestream replica in `/var/replica/app`. Adjust the names.

## The first 10 minutes (triage)

1. Write the time (UTC) at the top of a new file `incident_YYYY-MM-DD.md`. Nothing gets worse in 10 minutes if you go in order.
2. Is the service alive?
   ```sh
   systemctl is-active app
   curl -s http://127.0.0.1:8787/health
   ```
3. What does the last hour of log say? (JSON lines; secrets are already redacted)
   ```sh
   tail -n 300 /opt/app/data/log/app.log
   grep -c '"event":"auth_failed"' /opt/app/data/log/app.log
   grep -E '"event":"(exception|uncaughtException|queue_permanent_failure)"' /opt/app/data/log/app.log
   ```
4. Pick the case: (a) mass traffic · (b) abused key · (c) leaked secrets · (d) broken database · (e) dead machine · (f) compromised server · (g) deletion request.
5. If unsure between (f) and anything else, treat it as (f). A false alarm costs half an hour; an ignored compromise costs everything.
6. If you must stop: first the tunnel (no new traffic, the queue keeps draining), then the service.
   ```sh
   sudo systemctl stop cloudflared
   sudo systemctl stop app
   ```
7. Before touching anything else, copy the evidence somewhere outside the box: logs and config.

## (a) Mass traffic

The kit already does, on its own: per-IP bucket, blocking after repeated bad keys, capped queue, bounded bodies and URLs, timeouts.
1. Check it is an attack and not a broken client: is it always the same IP / user agent?
2. Check `behindTunnel: true`. If it is false behind a tunnel, every IP is 127.0.0.1 and blocking the attacker blocks everyone.
3. At the edge, from least to most disruptive: a rate-limit rule, custom block rules (country, user agent, path), then "under attack" challenge mode (it breaks scripted clients: remove it as soon as traffic drops).
4. If the box still cannot breathe, stop the tunnel. Queued work keeps going out.

## (b) Leaked or abused API key

1. Find the user by key prefix; check their usage.
2. Rotate their key (the old one dies at once) or disable the user.
3. Look in the log for what was done with it (IP, times).

## (c) Leaked config / secrets

Rotate everything in it. A new pepper invalidates **every** user key: tell users to request a new one. Rotate third-party tokens at their providers. Check the git history (`git log --all -- config.json`).

## (d) Broken or deleted database

From the replica inside the box:
```sh
systemctl stop app litestream
cd /opt/app/data && rm -f app.sqlite app.sqlite-wal app.sqlite-shm
litestream restore -config /etc/litestream.yml -o app.sqlite /opt/app/data/app.sqlite
chown app:app app.sqlite* && systemctl start app litestream
```
Add `-timestamp 2026-01-01T15:00:00Z` for a point in time. Try it first into `/tmp` and run `PRAGMA integrity_check`. If the box is gone, rebuild it and restore from the off-machine copy.

## (e) The machine is dead

Rebuild the box (or a VPS, same steps), deploy, restore data and config, point the tunnel connector at the new place.

## (f) You suspect someone got in

1. Stop the tunnel and the service.
2. Copy logs and anything odd out of the box.
3. **Rebuild** the box from scratch; do not clean it.
4. Rotate every secret (case c).
5. Restore data from a copy taken before the suspected time.
6. Write the post-mortem.

## (g) A user asks to be deleted

Delete their rows in every table, and add them to a deletion list that you re-apply after any restore.

## Post-mortem template

```
Date / duration (UTC):
What happened (timeline):
How we found out:
Impact (users, data):
Root cause:
What worked:
What did not:
Actions (owner, date):
```
