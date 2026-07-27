# Runbook — running the pipeline end to end

Point the pipeline at a live web app and it will crawl it, index the API +
UI surface, generate tests, and run them — ending in one unified report.

There are three commands: **scan → generate → execute**. `execute` re-generates
internally, so the shortest path is just `scan` then `execute`; `generate` is
there when you want to inspect the tests before running anything.

Everything runs against a live URL. No API keys, no codebase required (a
codebase only adds `file:line` handler annotations to the generated tests).

---

## 0. One-time setup

```bash
cd /Users/ankitmishra/projects/AI-Testing-Hook

# Env used by every step (same terminal session):
export URL="https://forge-preview.superalign.ai"   # the app under test
export LOGIN_EMAIL="ankit.mishra@superalign.ai"     # login identity
export HEADLESS=1                                    # crawl without visible windows
# export LOGIN_PASSWORD="..."                        # ONLY for username/password apps
# export CRAWL_WORKERS=4                             # optional; default 8, use 1 to debug
```

Login model, by app type:
- **Username/password** — set `LOGIN_PASSWORD`; the crawler fills the form itself.
- **"Sign in with Google/Microsoft/…"** (no MFA) — handled automatically, headless.
- **SSO + MFA** — needs a human once (Step 1 below); after that the saved
  session is reused headlessly until it expires.

---

## 1. Log in once (only if needed)

Skip this if a session already exists at `output/crawler/auth-state.json` and is
still valid. Run it the first time, or whenever a crawl reports it landed on
`/login`.

```bash
BASE_URL="$URL" node testo/src/crawler/login-once.mjs
```

A real browser window opens. The SSO button is clicked for you; complete any
password / MFA by hand. It auto-detects the landing and saves the session.

**Check the summary line** — it must show a real session, e.g.:

```
cookies:           3
IndexedDB dbs:     1      ← required for Firebase-auth apps; 0 here = login didn't stick
```

If both cookies and IndexedDB are 0, the login did not complete — run it again.

---

## 2. Scan (crawl + index)

```bash
node byo-llm-poc/ctx.mjs scan --url "$URL" --json
```

Crawls the app, records every route / clickable / network call, and indexes it.

Produces:
- `output/crawler/data/{click-graph,routes,pages}.json` — the crawl graph
- `output/indexed_output/{apis,routes,pages}.json` — indexed test surface
- `output/delegation/<runId>/` — clickables awaiting intent classification
- `output/run-summary.json` — counts + status envelope

---

## 3. Generate (write both test suites — no execution)

```bash
node byo-llm-poc/ctx.mjs generate --mode safe --url "$URL" --json
```

Writes both suites without running anything, so you can inspect first:
- **API tests** → `output/generation/api-tests/curls/` (one `.sh` per endpoint)
- **UI tests** → `tests/e2e/{flows,api,auth,forms}/*.spec.mjs` (Playwright)

(Optional — you can skip straight to Step 4, which regenerates anyway.)

---

## 4. Execute (run both suites + unified report)

```bash
node byo-llm-poc/ctx.mjs execute --mode safe --url "$URL" --json
```

Runs the API tests (curl) and the UI tests (Playwright, authenticated via the
crawler's saved session), then writes one report covering **every** test —
passed, failed, and skipped-with-reason.

Read the report:

```bash
cat output/generation/report.md
open output/generation/e2e/html/index.html   # Playwright's UI report
```

---

## Full pipeline in one line

```bash
node byo-llm-poc/ctx.mjs scan     --url "$URL" --json && \
node byo-llm-poc/ctx.mjs generate --mode safe --url "$URL" --json && \
node byo-llm-poc/ctx.mjs execute  --mode safe --url "$URL" --json
```

---

## Modes: `--mode safe` vs `--mode full`

| | `safe` (default) | `full` |
|---|---|---|
| Read-only (GET/HEAD), navigation, auth-gate checks | run | run |
| Mutations (POST/PUT/PATCH/DELETE, form submits) | **generated but skipped** (shown in report with a reason) | **run** |
| Catastrophic / session-breaking (logout, password reset, delete-self/account) | never run | **never run** (always protected) |

Start with `safe`. Use `full` only against a disposable / non-precious
environment — it creates and mutates real data, but still won't nuke the
account it's logged in as.

---

## Outputs at a glance

| Path | What |
|---|---|
| `output/run-summary.json` | Scan result: counts, stages, login-wall detection |
| `output/crawler/data/*.json` | Crawl graph (routes, pages, click-graph) |
| `output/indexed_output/*.json` | Indexed API + page surface |
| `tests/e2e/**` | Generated Playwright specs |
| `output/generation/api-tests/{results.json,report.md}` | API suite results |
| `output/generation/e2e/{results.json,html/}` | UI suite results |
| **`output/generation/report.md`** | **Unified report — every API + UI test** |

---

## Notes & troubleshooting

**Multiple workers.** `CRAWL_WORKERS` (default 8) controls crawl parallelism.
The pool logs one worker in first, captures its (rotated) session, then builds
the rest of the workers from that fresh session — so parallel workers all start
authenticated. Set `CRAWL_WORKERS=1` if you want to watch a run step by step.

**"redirected to /login" on every worker.** The saved session is stale or
empty. Re-run Step 1 and confirm the summary shows real cookies / IndexedDB.

**Firebase-auth apps.** The session lives in IndexedDB, not cookies — that's
why Step 1's summary reports `IndexedDB dbs`. If it says 0 for a Firebase app,
the session won't authenticate anything.

**API tests return 401 in safe mode.** Some apps mint a per-request bearer
token from an in-browser store (e.g. Firebase). A raw curl / API request won't
carry that token, so authenticated API calls can 401 even though the UI
navigation tests pass. Bearer-token injection for these is a known follow-up.

**Re-running without re-crawling.** `SKIP_CRAWL=1` reuses the existing
`output/crawler/` instead of crawling again — handy while iterating on
generate/execute.
