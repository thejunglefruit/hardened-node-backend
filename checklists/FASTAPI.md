# Checklist: local FastAPI backends

For FastAPI servers that back a desktop app and listen on `127.0.0.1`. The danger is not the internet: it is any web page open in the browser, or any program on the machine, talking to them.

| # | Check | How |
|---|---|---|
| 1 | Listen on `127.0.0.1` only, never `0.0.0.0` | `uvicorn.run(app, host="127.0.0.1")` |
| 2 | No `allow_origins=["*"]`; a middleware that rejects a foreign `Origin` and `"null"` | return 403 before routing |
| 3 | File paths checked with `os.path.commonpath` against the allowed folders, never `startswith` | every endpoint that reads or writes files |
| 4 | Endpoints serving files outside the work folders: media extensions only | allow-list of suffixes |
| 5 | Maximum body / upload size (e.g. 50 MB) and a timeout | middleware counting `Request.stream()` |
| 6 | No `subprocess` built from user input, `shell=True` forbidden; argument lists only | ffmpeg, blender and friends |
| 7 | URLs the server opens: http(s) only, no private IPs or local names, size cap, connect to the checked IP | port `src/ssrfGuard.js` with `ipaddress` + `socket.getaddrinfo` |
| 8 | Errors: generic 500 to the client, detail to the log; `debug=False` | `@app.exception_handler(Exception)` |
| 9 | A local token for sensitive routes (shutdown, delete, execute) | random header token generated into the config on first run |
| 10 | No secrets in the repo; `.env` and private configs in `.gitignore` | `gitleaks` / `trufflehog` once |
| 11 | `pip audit` clean; pinned versions | `requirements.txt` with `==` |
| 12 | Logs without personal paths or tokens | redact like `src/logger.js` |
| 13 | Tests with `fastapi.testclient`: foreign Origin → 403, `../` path → 400, huge body → 413 | one test per row above |

If one of these apps ever goes on the internet, apply the whole kit: a Python equivalent of `harden()` (per-IP limits, hashed keys, persistent queue) and the deployment in `resilience/`.
