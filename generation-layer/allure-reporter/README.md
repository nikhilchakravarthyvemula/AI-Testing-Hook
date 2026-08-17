# allure-reporter

Consolidates **API + UI + Performance** results into one **Allure** report.
Deterministic, no LLM. Writing the Allure result JSON needs nothing installed; rendering uses the
Allure CLI (a Java app — Java is present, so it runs via `npx allure-commandline`).

```bash
# 1. produce inputs (generates API+UI suites and runs them)
node byo-llm-poc/ctx.mjs generate --json && node byo-llm-poc/ctx.mjs execute --json

# 2. consolidate + view
node generation-layer/allure-reporter/build.mjs --serve           # open the report
node generation-layer/allure-reporter/build.mjs --generate        # static HTML → output/generation/allure-report/
node generation-layer/allure-reporter/build.mjs                   # build allure-results/ only
```

## What each suite shows
- **API** — one Allure test per endpoint: **passed / failed**, failure **reason** in the status
  message (e.g. `expected 200, got 500`), response body attached. Counts roll up in the Allure
  overview. Source: `api-tests/results.json`, falling back to `openapi-tests/results.json`.
- **UI** — the scenario flow as a test with one sub-step per scenario step, a **screenshot
  attached after every step**, and Web Vitals as parameters. Source: `ui-tests/run-result.json`.
- **Performance** — timing captured during the UI run, grouped into **Routes** (per-route
  navigation timing), **API calls** (per-request timing, supplemented from the API suite), and
  **Objects** (per-resource load timing). CSV attachments for the full waterfall. Source:
  `ui-tests/perf-timing.json`.

`categories.json` buckets failures (auth, perf budget, UI assertion, 4xx, 5xx);
`environment.properties` records the target + scenario.

## Output
`output/generation/allure-results/` — the raw Allure results (feed to any `allure serve`).
`output/generation/allure-report/` — the rendered static site (with `--generate`).

> Standalone Node script. Rendering downloads `allure-commandline` on first `npx` use; or
> `brew install allure` for a global CLI (auto-detected).
