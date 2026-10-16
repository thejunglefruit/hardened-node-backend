# OWASP ASVS 5.0 Level 1, mapped to the kit

An adaptation of the ASVS L1 requirements to an API authenticated with API keys (no passwords, no browser sessions). "Kit" means it is already in `src/`; "App" means each app must do it.

## A. Architecture and deployment
| Requirement | Who | Where |
|---|---|---|
| Listen on loopback only; the public reaches you through a tunnel or proxy | App | `server.listen(port, '127.0.0.1')` |
| Trust the client-IP header only from the tunnel | Kit | `clientIp.js` |
| `behindTunnel: true` in production | App | `harden()` options |
| Run as an unprivileged user under a supervisor | App | `resilience/systemd/app.service` |
| Server timeouts against slowloris | Kit | `harden()` sets `headersTimeout` / `requestTimeout` |
| Documented route inventory (nothing forgotten) | App | README |

## B. API-key authentication
| Requirement | Who | Where |
|---|---|---|
| Keys from a CSPRNG, at least 128 bits | Kit | `generateKey()` |
| Store only a peppered hash | Kit | `hashKey()` |
| Constant-time comparison | Kit | `compareHash()` (`timingSafeEqual`) |
| Show the key once (creation / rotation) | App | |
| Anti-automation against brute force | Kit | `createFailureCounter()` |
| Revocation and rotation by the user | App | |
| Key accepted in a header, not only in the URL | App | `examples/server.js` reads `x-api-key` |
| No default accounts; admin tokens random and compared in constant time | App | |

## C. Authorisation
| Requirement | Who |
|---|---|
| Deny by default: no valid key, nothing happens | App |
| Object-level checks (a user only touches their own objects) | App |
| Admin routes hidden without a token (404, not 401) | App |

## D. Input validation
| Requirement | Who | Where |
|---|---|---|
| 100 % prepared SQL statements | Kit / App | `persistentQueue.js` |
| Validate key shape before querying | Kit | `isValidKeyShape()` |
| Body ≤ 100 KB, URL ≤ 2048, JSON must be an object | Kit | `readBody()`, `harden()` |
| Allow-lists (regex) for names, ids, file names | App | |
| No `eval` or dynamic execution | App | |

## E. SSRF
| Requirement | Who | Where |
|---|---|---|
| Block private IPv4/IPv6, including mapped, 6to4 and NAT64 | Kit | `isPrivateIp()` |
| Block internal names (`localhost`, `.local`, `.internal`, metadata) | Kit | `checkUrl()` |
| Ports 80/443 only, no credentials in the URL | Kit | `checkUrl()` |
| Connect to the checked IP (no DNS rebinding) | Kit | `safeFetch()` |
| Re-check redirects; cap size and time | Kit | `safeFetch()` |
| https only in production | App | `httpsOnly: true` |

## F. Logging and errors
| Requirement | Who | Where |
|---|---|---|
| Generic errors to the client, detail to the log | Kit | `errors.js` |
| Secrets and phone numbers redacted | Kit | `logger.js` |
| Structured JSON with ISO time and rotation | Kit | `createLogger()` |
| Log authentication failures and sensitive actions | App | `examples/server.js` logs `auth_failed` |
| Alerts to the operator | App | |
| Logs copied off the machine | App | |

## G. Configuration and secrets
| Requirement | Who |
|---|---|
| Secrets outside the repository, generated on first run | App |
| `chmod 600` on config, `700` on data | App |
| Security headers and no CORS | Kit (`headers.js`) |
| HSTS only behind the tunnel | Kit |
| Git history checked for secrets | App |

## H. Dependencies
| Requirement | Who |
|---|---|
| The kit has zero dependencies | Kit |
| Lockfile and periodic `npm audit` | App |

## I. Availability and backups
| Requirement | Who | Where |
|---|---|---|
| Per-IP limits and blocking on failures | Kit | `rateLimit.js` |
| Persistent queue with a cap and retries | Kit | `persistentQueue.js` |
| Continuous database replica | App | `resilience/litestream.yml` |
| Off-machine copy (3-2-1), encrypted | App | |
| Restore drill done and timed; RPO / RTO written | App | `docs/INCIDENT_PLAYBOOK.md` |

## J. Minimal privacy (GDPR)
| Requirement | Who |
|---|---|
| Store the minimum; do not keep message content longer than needed | App |
| Real deletion on request, re-applied after restoring a backup | App |
| Retention defined for usage tables and logs | App |
