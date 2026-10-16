# Threat model template

Copy this for each app and fill it from the real code: every control cites the module and the test that proves it. Anything not in the code is marked *pending*. The rows below are the ones the kit already answers; keep them and add your app's own.

## 1. Assets

| Asset | Where it lives | If lost or stolen |
|---|---|---|
| API keys | only a peppered SHA-256 + 8-char prefix | one key in clear spends that user's quota |
| The pepper and other server secrets | config file, `chmod 600` | pepper + database = keys become testable offline |
| The database | SQLite + Litestream replica | service down; personal data exposed |
| The host and the LAN | the machine running the box | pivot to your files and network |
| The accounts (email, edge, registrar, code host) | external | takeover of domain, tunnel and payments |

## 2. Actors

| Actor | Goal | Capability |
|---|---|---|
| Scanner / script kiddie | a vulnerable server, verbose 500s, admin routes | automated, many IPs |
| Scraper | enumerate users or keys | mass requests |
| Abuser with a valid key | use your service as a relay for spam | a real key and its quota |
| Leaked key | a third party spends someone's quota | the owner's quota |
| Insider web page | a site open in your browser calling your local API | your browser's network position |

## 3. Entry points and STRIDE

| Threat | Control in the kit | Test | Residual |
|---|---|---|---|
| **S** forge the client IP to dodge limits | `clientIp.js` trusts headers only from a local tunnel | attack "IP spoofing" | with `behindTunnel: false` behind a proxy, everyone shares one IP |
| **S** guess API keys | 128-bit keys, peppered hash, constant-time compare, failure counter | "Brute force" | an attacker with many IPs spreads the failures; 2^128 still wins |
| **T** SQL injection | prepared statements, key shape validated first | "SQL injection" | app queries must stay prepared |
| **T** prototype pollution through JSON | `JSON.parse` + object spread define own properties only | "Prototype pollution" | app code that deep-merges user objects |
| **R** "I never sent that" | JSON-lines log | — | *pending in each app*: log each sensitive action with key prefix |
| **I** error detail leaks | generic 500, detail to log, no `x-powered-by` | "Error leak", "Fingerprinting" | — |
| **I** secrets in logs | `redact()` | "Log harvesting" | messages you build by hand with secrets inside |
| **I** key in the URL | header accepted; `apikey=` redacted in own logs | — | URLs stay in third-party proxy logs |
| **D** floods and bursts | token bucket per IP, bounded tables | "Request flood", "Memory exhaustion" | distributed floods: the edge's job |
| **D** body / URL bombs, slowloris | caps and server timeouts | "Body bomb", "Body flood", "URL bomb", "Slowloris" | — |
| **D** queue flooding | capped persistent queue | "Queue flooding" | a legitimate user can still fill their share |
| **E** SSRF into the LAN or cloud metadata | `checkUrl` + `safeFetch` | the four "SSRF" families | parsers in other libraries that open URLs on their own |
| **E** cross-site calls to your API | Origin check, no CORS, `null` rejected | "Cross-site request", "Sandboxed iframe", "Look-alike origin", "CORS write" | — |

## 4. Residual risks, accepted on purpose

Write them down with the reason and the date you will look at them again.
