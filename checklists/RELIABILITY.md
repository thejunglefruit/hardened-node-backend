<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright (c) 2026 The Jungle Fruit -->
# Reliability checklist: what matters at small scale

A solo or small-team backend (one server, SQLite, a few hundred users) needs roughly fifty production concepts, not a hundred and eleven. This is the short list, with where each lives in the kit. Everything under "Only at large scale" is real engineering, but adding it without a measured symptom just adds moving parts.

## Matters from day one
| Concept | Where |
|---|---|
| Rate limiting, bounded bodies, timeouts on the server itself | `harden()` |
| Timeouts on every outgoing call | `withTimeout()`, and `signal` on `fetch` |
| Retries with exponential backoff and jitter, only for transient errors, with a time budget | `retry()` |
| Circuit breaker around anything that can be down | `circuitBreaker()` |
| Idempotency for anything that charges, sends or writes elsewhere; replayed webhooks | `createIdempotency()` (`once`, `seenEvent`) |
| A queue that survives a crash, has a cap (backpressure) and a dead-letter set you actually look at | `createPersistentQueue()` (`listDead`, `requeue`, `onDead`) |
| Liveness and readiness kept apart | `createHealth()` |
| Structured logs without secrets, with a request id | `createLogger()`, `withTrace()` |
| Metrics: latency percentiles, error rate, an SLO and its error budget | `createMetrics()` |
| Numbered migrations and a schema version | `migrate()` |
| A switch for risky features, rolled out by percentage | `createFlags()` |
| Cache with a cap, a TTL, stampede protection and invalidation | `createCache()` |
| Backups that are restored on purpose, replication, graceful shutdown | `resilience/`, `shutdown.js` |
| Secrets out of the repo, dependencies audited, SSRF / CORS / injection covered | `checklists/NODE.md`, `ASVS_L1.md` |

## What to write down (no code can do it for you)
- **SLO**: pick two indicators (requests under 500 status, requests under a latency threshold), a target (99.5 % over 30 days is a fair start) and a policy for when the error budget is spent (freeze features, fix reliability).
- **On-call for one person**: what wakes you (readiness down for 5 minutes, budget exhausted, no backup in 24 h), what waits for tomorrow, what waits for the weekly review. An alert you ignored three times gets deleted or demoted.
- **Postmortem, blameless, within 48 hours** of any outage: timeline, five whys down to something in the system, actions with an owner and a date.
- **API versioning**: additive changes stay in `/v1`; anything that breaks a client is `/v2`, with `Deprecation` and `Sunset` headers on the old one.

## Only at large scale (and what triggers it)
Load balancing, autoscaling and Kubernetes (a single machine at its CPU limit with p99 climbing), service discovery and API gateways (three or more public services repeating the same rules), pub/sub and event-driven design (several processes must react to one fact), distributed transactions and sagas (one operation touches two or more databases or paid services), read replicas, sharding and partitioning (tables with tens of millions of rows), leader election and distributed locks (more than one writer), blue-green and rolling deploys (a few seconds of downtime costs money), multi-region (measured latency for distant users, or a legal requirement), Terraform and Helm (more than one server). Until then: indexes and `EXPLAIN` first, a bigger box second.

## Common database slips
- Missing index on a column you filter or join by (`EXPLAIN QUERY PLAN` shows `SCAN`, you want `SEARCH … USING INDEX`).
- N+1: one query per row of another. One `JOIN` or `IN (…)` instead.
- Read, decide, write in three steps under concurrency. Do it in one statement (`UPDATE … WHERE balance >= ?`, check `changes`) or one `BEGIN IMMEDIATE` transaction.
- Unbounded in-memory lists, caches and listeners: the usual memory leak. Everything in the kit has a cap.
