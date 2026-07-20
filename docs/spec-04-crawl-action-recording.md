# Spec 04 — Record crawl actions and reuse them for test-script generation

_Target layers: **Context Layer** (crawler + indexer) → **Generation Layer** (test-script-generator)._

> **In one line:** While the crawler drives the browser, record the exact action it took
> (strongest selector + the value it typed + step order) so the test generator can emit
> **replayable** Playwright specs using real selectors, real values, and real assertions —
> instead of fragile text matches, hardcoded fills, and `.skip`-ed forms.

**Decisions (confirmed):** custom action log · augment click-graph edges **and** dedicated
ordered recordings · **full replay** scope (un-skip forms, build flows from recordings).

---

## 1. Context / problem

During a crawl the harness drives a real browser and performs real clicks / fills /
navigations, but it only persists a **static click-graph** (what UI exists and how pages
link) — not an **ordered, replayable action script**. Consequently the Playwright generator:

- clicks via fragile `button:has-text("…")` text matches (breaks on duplicate/renamed labels),
- fills forms with hardcoded literals (`test@example.com`, `TestPassword123!`),
- `.skip`s login/form tests because it can't infer a success condition.

Recording the actual action and reusing it removes all three weaknesses.

### Two facts that shape the design (verified)
- **Crawlee is retired.** `context-layer/content-extractor/crawler/crawl.mjs:19` — the crawler now drives
  Playwright/chromium **directly** via a custom DFS worker pool (`context-layer/content-extractor/crawler/walker/`).
  The click/fill calls already pass through code we own, so the recorder is a **hook, not a
  rewrite**. (Crawlee was a crawl *framework* that wrapped Playwright; it is no longer used.)
- **Live code is under `context-layer/content-extractor/crawler/`.** The reorg's
  `context-layer/content-extractor/crawler/` and `generation-layer/test-script-generator/`
  are adapter shells / empty — `context-layer/content-extractor/crawler/extract.mjs:44` just
  runs the `context-layer/content-extractor/crawler` pipeline. Implement against `context-layer/content-extractor/crawler/`; the adapter
  needs no change. (De-duplicating these copies is separate cleanup item **E24**.)

---

## 2. Approach

### Phase A — Record actions during the crawl (`context-layer/content-extractor/crawler/`)
1. **`bestLocator()`** in `walker/scanner.mjs` — return a Playwright-ready locator string with
   a stability priority, reusing fields the scanner already computes per interactable:
   `testid` → `idAttr` → `role` + accessible `name`/`label` → exact `text` → `href` →
   css `selector` (`nth-of-type` fallback). The existing `clickableLocator()` (~scanner.mjs
   102–109) already makes this choice — expose the chosen **strategy string**, not just the
   live locator.
2. **Click/nav recorder** in `walker/worker.mjs` click loop (~332–459, around
   `clickLoc.click()` ~381 and the nav/state detection ~397–404): emit
   `{ sessionId, stepIndex, action:'click'|'nav', locator, text, fromUrl, toUrl, hadNav, latencyMs }`.
   `sessionId` = the worker's DFS path/root; `stepIndex` = monotonic per session.
3. **Form-fill recorder** in `crawl.mjs` form-fill block (~578–584): record
   `{ action:'fill', locator, name, type, value /* value actually typed */ }` per field, plus
   the **submit** action and the **post-submit URL/state** (becomes the test assertion).
4. **Outputs:**
   - Augment click-graph edges in `walker/state.mjs` (edge build ~100) with `{ locator, action, value }`.
   - Write ordered per-flow transcripts → `output/crawler/recordings/<sessionId>.json`, plus a
     flat `output/crawler/actions.ndjson` (reuse the `requests/responses.ndjson` sink pattern
     in `crawl.mjs` ~289–377).
   - All new fields **optional** → existing consumers keep working if absent.

### Phase B — Carry recordings through the indexer (`context-layer/indexer/`)
5. `topics/click-graph.mjs` (edge payload copy ~258–260): pass `locator`/`action`/`value` into
   `output/indexed_output/click-graph.json` edges.
6. New `topics/recordings.mjs` + register in `index.mjs` + add a `recordings` source in
   `lib/sources.mjs` — read `output/crawler/recordings/*.json` →
   `output/indexed_output/recordings.json` (provenance tier `live_observed`, conf 0.95).

### Phase C — Reuse recordings in generation (`context-layer/content-extractor/crawler/generator/`)
7. `e2e.mjs` `generateStepCode()` (~546–582; selector at ~576): prefer recorded `step.locator`
   over `button:has-text("…")`, use recorded `action`, and build the ordered flow from the
   recorded transcript when present (fallback = current DFS-edge synthesis).
8. `generator.mjs` `fillValueLiteral()` (~377–387) + form-test block (~395–410): prefer the
   **recorded value** per field; **un-`.skip`** login/form tests when a recorded successful
   submit exists, asserting the **recorded post-submit URL/state**. Keep the existing
   `fillField()` selector-priority helper, fed with the recorded locator.

---

## 3. Files to change

| File | Change |
|------|--------|
| `context-layer/content-extractor/crawler/walker/scanner.mjs` | add `bestLocator()` (reuse `clickableLocator`/`selectInteractables`) |
| `context-layer/content-extractor/crawler/walker/worker.mjs` | record click/nav in the click loop |
| `context-layer/content-extractor/crawler/crawl.mjs` | record form fills + submit + post-state; `actions.ndjson` sink |
| `context-layer/content-extractor/crawler/walker/state.mjs` | augment edges; write `recordings/` |
| `context-layer/indexer/topics/click-graph.mjs` | carry `locator/action/value` onto edges |
| `context-layer/indexer/topics/recordings.mjs` *(new)* | emit `recordings.json` |
| `context-layer/indexer/lib/sources.mjs`, `index.mjs` | load + register the recordings source |
| `context-layer/content-extractor/crawler/generator/e2e.mjs` | use recorded selector/value/order for flows |
| `context-layer/content-extractor/crawler/generator/generator.mjs` | recorded fills + un-skip forms with recorded assertions |

### Reuse (don't reinvent)
- Selector selection — `clickableLocator()` / `selectInteractables` field set in `scanner.mjs`.
- NDJSON sink — the `requests/responses.ndjson` writers in `crawl.mjs` (~289–377).
- Fill fallback — `fillField()` (name→id→placeholder→aria→label) in `helpers/login.mjs` / `generator.mjs`.
- Backend-handler annotation — `findHandler()` in `e2e.mjs` stays as-is.

---

## 4. Verification (end-to-end)

1. **Crawl** a known app (e.g. logtrim) with a target URL → confirm
   `output/crawler/recordings/*.json` + `output/crawler/actions.ndjson` exist with
   `{locator, action, value, stepIndex}`, and click-graph edges now include `locator/action/value`.
2. **Index** → `output/indexed_output/click-graph.json` edges carry the new fields and
   `output/indexed_output/recordings.json` is produced.
3. **Generate** (`testo generate ui-tests`) → a generated `tests/e2e/*.spec.mjs` uses recorded
   `#id` / `[data-testid]` selectors and **real recorded values** (not `button:has-text` /
   `test@example.com`), and a login/form test is no longer `.skip` and asserts the recorded
   post-submit state.
4. **Replay** the generated spec with Playwright against the live app → it passes (replays the
   exact recorded flow).

---

## 5. Out of scope (this pass)
- Not migrating the `context-layer/content-extractor/crawler/` ↔ `context-layer`/`generation-layer` duplication (**E24**).
- No Playwright native `trace.zip` (custom action log chosen). Could be added later as an
  opt-in debug artifact via `context.tracing`.
- No branch/error-recovery flow modeling beyond the happy-path session + form submit.
