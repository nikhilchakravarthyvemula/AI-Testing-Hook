# P0-08 — Final Report · SPEC

**Status:** Draft v1.0 (for review)
**Depends on:** p0-03 (store: gaps, features, facts), p0-07 (results),
p0-01 (run.json + ledger), existing `graph-viewer` shapers, existing
`pdf-reporter` machinery
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

1. Full logtrim safe-mode run: all four sections populated; §B shows the
   skipped mutation scenarios and untested endpoints; §D's numbers reconcile
   exactly with `ledger.jsonl` line sums.
2. Degraded run (mock engine): report still renders; §D lists every
   fallback; §A shows template-generated provenance per test.
3. URL-only profile: §B renders its "no codebase" explanations instead of
   silently omitting audit rows.
4. `index.html` opens from file:// with no network requests (verified via
   devtools); PDF paginates sanely with screenshots included.
