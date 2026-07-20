# ui-test-generator

Scenario → runnable Playwright **UI test + Web Vitals**. Deterministic, **no LLM**,
**no install** (uses the `playwright` library + Chromium already in the repo; **not**
`@playwright/test`).

```bash
node generation-layer/ui-test-generator/gen.mjs scenario.json            # generate + run
node generation-layer/ui-test-generator/gen.mjs scenario.json --no-run   # generate + node --check only
node generation-layer/ui-test-generator/gen.mjs scenario.json --url https://staging...
```

## What it does
1. Reads + validates `scenario.json` (known actions/asserts; no schema framework).
2. Emits `output/generation/ui-tests/<name>.ui.mjs` — a self-contained script that drives
   `chromium` directly. All selectors/URLs are `JSON.stringify`-escaped.
3. `node --check`s the emitted script (validation gate).
4. Runs it: optional login → each `step` → **Web Vitals** via `PerformanceObserver`
   (LCP/CLS) + Navigation/Paint timing (FCP/TTFB/load).
5. Writes `results.json` + `report.md` (same shape as `api-test-generator`) with a per-step
   pass/fail list and a metric-vs-threshold table. Credentials are passed via env, never
   written to disk.

## Auth
- `type: "storageState"` (default for SSO targets like superalign): reuses a session saved by
  the repo's one-time interactive login. Do it once:
  ```bash
  cd context-layer/content-extractor/crawler && npm run login      # headed browser → output/crawler/auth-state.json
  ```
  Then the test loads that session and runs authenticated. (Google-SSO logins can't be driven
  headlessly, which is why this exists.)
- `type: "login-form"`: headless username/password — for non-SSO apps. Provide
  `emailSelector`/`passwordSelector`/`submitSelector` + `$LOGIN_EMAIL`/`$LOGIN_PASSWORD`
  (resolved from env / repo `.env`).
- `type: "auto"`: storageState if a saved session exists, else login-form.
- `type: "none"`: no auth.

## Scenario shape
See `scenario.json` at the repo root. It is the hand-authored stand-in for the future
`test-plan-creator` output — every factual field (baseUrl, selectors, steps, assertions) maps
to context-layer output (`apis.json`, `pages.json`, `click-graph.json`); only the perf
thresholds are human SLO choices.

## Screenshots wait for content
Before each screenshot the run waits (bounded) for loading indicators to clear, so the PDF/Allure
captures rendered content, not a spinner. Tune per scenario:
- `screenshotSettleMs` (default `10000`) — max wait for loaders to disappear.
- `loaderSelector` (default `.animate-spin, [aria-busy="true"], [role="progressbar"]`) — your app's
  spinner/skeleton selector. Resolves instantly when nothing matches.

## Headless / server (GCP VM, terminal-only)
The browser runs **headless — no display/Xvfb** needed. On a fresh VM: `npx playwright install
--with-deps chromium` once. Running as root (containers/CI): set `PW_NO_SANDBOX=1` (auto-detected
at uid 0) → adds `--no-sandbox --disable-dev-shm-usage`. For SSO targets, run the headed
`npm run login` on a machine *with* a display and copy `output/crawler/auth-state.json` to the VM;
the headless run reuses it via `storageState`.

> Standalone Node script (run via `node`). Not yet registered as a skill — wiring into
> `skill-register` / `testo generate ui-tests` is a later step.
