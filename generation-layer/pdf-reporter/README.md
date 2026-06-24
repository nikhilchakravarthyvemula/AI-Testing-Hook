# pdf-reporter

One **shareable PDF** consolidating **API + UI + Performance** results. Allure (open-source) has no
PDF export, so this builds a clean, purpose-built one from the same data. Deterministic, no LLM,
**no new dependency** — renders print-CSS HTML and prints it with the installed `playwright`
library's `page.pdf()`.

```bash
node generation-layer/pdf-reporter/build-pdf.mjs            # → output/generation/report.pdf
npm run pdf                                                 # same
npm run report:pdf                                          # UI → perf → pdf, end to end
```

## Contents
- **Cover** — target, scenario, date, and pass/fail tiles for API / UI / Perf.
- **API** — every endpoint: method · path · status · ms · result, with the **failure reason**
  inline; pass/fail counts.
- **UI** — each step with status + duration and its **screenshot embedded** (base64 → self-contained
  PDF), plus the Web Vitals table.
- **Perf** — Routes (navigation timing), API-call timing, and slowest Objects tables.

Inputs (whatever exists): `api-tests`/`openapi-tests` `results.json`, `ui-tests/run-result.json`
(+ `screenshots/`), `ui-tests/perf-timing.json`. Output: `output/generation/report.pdf` (+ a
`report.html` intermediate for debugging).

## Headless / server (GCP VM, terminal-only)
Headless Chromium renders **off-screen — no display, no Xvfb** needed, so the PDF builds fine on a
terminal-only VM. Two VM notes:
- **One-time setup:** `npx playwright install --with-deps chromium` (browser + apt libs).
- **Running as root** (containers/CI): set `PW_NO_SANDBOX=1` (auto-detected when uid 0) — the
  launch then adds `--no-sandbox --disable-dev-shm-usage`.
- **SSO sessions** for the UI run are produced by the headed `npm run login` on a machine *with* a
  display; copy `output/crawler/auth-state.json` to the VM and the headless run reuses it via
  `storageState`.

> Standalone Node script. No Java needed (that was only for the Allure HTML report).
