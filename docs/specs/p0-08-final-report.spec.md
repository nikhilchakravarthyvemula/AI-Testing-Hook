# P0-08 — Final Report · SPEC

**Status:** v1.1 — **IMPLEMENTED 2026-07-20** (`execution-layer/report-generator/`:
`render.mjs` + `lib/{gather,layout,html,assets,pdf}.mjs` + `lib/sections/{results,
coverage,appmap,transparency}.mjs`; wired as the spine `report` stage).
`npm run test:report` — 6 tests (four-section render, self-containment, --yes
disclosure, thin/degraded honesty, url-only, file write). All four acceptance
criteria covered — see §4, §5. Whole-product e2e in `test/e2e/` (the real
`runStages` loop → a report always comes out).
**Depends on:** p0-03 (store: gaps, features, facts), p0-07 (results),
p0-01 (run.json + ledger), existing `pdf-reporter` machinery (chromium `page.pdf()`)
**Consumed by:** humans. This is the product.

> One consolidated, self-contained deliverable per run: `report/index.html`
> (interactive) + `report/report.pdf` (shareable), four mandatory sections.
> Everything upstream exists to fill this file; if a section can't be
> populated, the report says so rather than shrinking.

---

## 1. Purpose & Non-Goals

**Purpose.** Render results + coverage audit + app map + run transparency
from the run workspace into a single HTML file (inline CSS/JS, no external
requests) and a PDF derived from the same data.

**Non-Goals.**
- MUST NOT call an LLM — rendering is deterministic. (Narrative summaries are
  a possible later touchpoint; not in the catalog, so not in P0.)
- MUST NOT read anything outside the run workspace (blank-slate: no deltas
  vs previous runs, no history).
- MUST NOT drop a section when its data is thin — an empty section renders
  with an explanation ("no codebase provided → declared-vs-observed audit
  unavailable"), keeping the report honest about its own limits.
- MUST NOT duplicate allure: allure-reporter remains available for deep
  per-step drill-down; this report is the consolidated audit document.

## 2. The four sections

### §A Test results
From `results/results.json` + manifest: summary tiles (passed / failed /
skipped-mutation / error / failed-generation), per-feature table, per-test
rows with duration, failure reason, screenshot lightbox. Mutation skips are
visually distinct — they are coverage statements, not noise.

### §B Coverage & gap audit — the signature section
From the store's `gaps[]` joined with results: for each gap, whether this
run's tests addressed it (`gapRefs` in the plan → scenario → result). Explicit
subsections: spec-declared-but-unobserved, shadow endpoints,
documented-but-absent (P1, needs S3 — rendered as "source not available" in
P0), untested endpoints, mutation tests skipped by safe mode. Each item:
subject, severity, evidence (provenance), what-would-cover-it.

### §C App understanding map
From the store's features/facts via the existing `graph-viewer` shapers:
feature → pages/endpoints interactive graph, confidence-shaded; per-feature
inventory tables. "Here is what the harness understood" — the trust surface
and the first stop when a §A result looks wrong.

### §D Run transparency
From `run.json` + `ledger.jsonl`: target + profile + mode; sources consulted
(and not — e.g. "Jira/Confluence: no credentials provided"); per-use-case
engine call counts, cache hits, tokens, budget spent vs cap; every
degradation entry (what fell back, why, what that means for confidence);
checkpoint record (approvedAt, `--yes` disclosure); stage timings.

## 3. Rendering

- `report-generator/render.mjs --workspace <dir>` → `report/index.html`;
  self-contained (single file, inline assets), responsive, light/dark.
- PDF via the existing pdf-reporter approach (headless `page.pdf()` on the
  same HTML with a print stylesheet) → `report/report.pdf`.
- Section renderers are pure `data → html` functions, unit-testable without
  a browser.

## 4. Acceptance

1. ✅ **Four sections, real content, ledger reconciled.** Rendered from a full
   model: §A shows pass/fail/skip with agent-vs-template provenance; §B shows the
   shadow/untested gaps + whether a test exercised each + the safe-mode-withheld
   mutations; §C the confidence-shaded feature inventory; §D sums `ledger.jsonl`
   per use case (requests/cache/tokens) against the budget. (The full *logtrim
   live* run is the P0 acceptance run, not a unit test.)
2. ✅ **Degraded run.** `test/e2e/` drives the real spine with the mock engine and
   no fixtures → template plan + template generation + real execution; a report
   still comes out, §D lists every fallback (`S1/plan`, `A1/generate`), and §A
   shows `template` provenance. Also proven with a real PDF (222 KB) end-to-end.
3. ✅ **URL-only profile.** §B and §D render explicit "no codebase provided"
   notes instead of silently omitting the declared-vs-observed audit.
4. ✅ **Self-contained.** No `src`/`href` points off-box (asserted); CSS/JS inline;
   screenshots inlined as `data:` URIs — so it opens from file:// with zero
   requests. PDF is the same HTML via chromium `page.pdf()` with a print
   stylesheet (verified: 222 KB, screenshots embedded).

## 6. What we built — deviations & notes

- **§C from store accessors, not the graph-viewer.** The report must be ONE
  self-contained file (§3); embedding the interactive graph-viewer (a separate
  multi-file tool) would break that. `listFeatures`/`featureContext` already give
  the same feature→endpoints/pages join the shapers do, so §C renders as
  confidence-shaded inventory tables. The graph-viewer stays available standalone.
- **PDF is best-effort.** A missing/broken chromium degrades to HTML-only (a
  disclosed degradation), never failing the `report` stage — the HTML is the
  product, the PDF a shareable copy. `REPORT_SKIP_PDF=1` skips it for fast CI.
- **`gather` is defensive by contract.** Every input is optional; a missing store/
  results/plan becomes an honest empty section, so a thin or fully-degraded run
  still produces a report (p0-00 acceptance 2). No input outside the workspace is
  read (blank-slate).
- **Deterministic, no LLM** (§1). Section renderers are pure `model → html`,
  unit-tested without a browser; `runReport` only adds the fs write + PDF.
- **`failed-generation` gets its own §A tile**, derived from results entries whose
  `reason` is `failed-generation`, so generation losses read distinctly from
  execution errors.
