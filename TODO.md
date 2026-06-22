# Project TODOs

Planned improvements for the Crawlee + Playwright crawler.

---

## In progress

_(none — slot any active work here)_

## Planned

### LLM-assisted button classification (cases regex doesn't cover)

**Status update (2026-05-19):** The regex-based safe-click pass (`INTERACT_MODE=1`)
now exists and works — see Done. It catches the high-leverage 80% of button
interactions on logtrim it ran against (e.g. found `PATCH /patterns/{id}/toggle`
+ `GET /apps/logs/detailed` that BFS missed). LLM classification is still
worthwhile for the long tail:



**Goal:** Today the crawler only follows `<a href>` links during BFS — buttons are captured as data but never clicked. To exercise endpoints behind buttons (row-expand, "Load more", "View details", filter chips, etc.) we currently need explicit `POST_CRAWL_CLICKS` env entries. Use a small local LLM to classify each captured button as **safe-to-click** vs. **destructive**, then run a "safe-click pass" after the main BFS.

**Why now:** Several useful endpoints in the May 15 reference run (e.g. detail-row expansions on `/approvals`, filters on `/aggregated-logs`) were missed by passive crawl because they're button-driven. Manual wiring scales poorly to 200+-page apps.

**Approach:**

1. **Capture is already done.** Every page's `clickables.buttons` in `output/crawler/pages.json` has text, type, aria-label, data attrs. No new crawler work needed for input.

2. **New script: `scripts/crawler/classify.mjs`.** Reads `pages.json`, sends each button (page URL + text + aria-label + any nearby heading) to a local model with a prompt like:
   > Given this button on this page, classify as: `safe-read` (loads more data), `safe-nav` (navigates within the app), `destructive` (delete/cancel/sign-out/disable), `mutating` (create/update/submit), `unknown`. Reply with one word.

   Output: `output/crawler/button-classification.json` — `{pageUrl, buttonText, classification, confidence}`.

3. **New script: `scripts/crawler/safe-click.mjs`.** Reads `button-classification.json`, for each button labeled `safe-read` or `safe-nav` (above confidence threshold): navigate to the page, click the button, capture the network traffic into the same raw streams (appending to existing run).

4. **Pipeline:** `npm run all` becomes `crawl → analyze → classify → safe-click → analyze (rerun) → spec → mindmap`. The second `analyze` pass picks up the new captures.

**Model choice:**
- Local Ollama: `llama3.1:8b` or `qwen2.5-coder:7b`. Single-shot classification is the kind of task local models handle fine (per the May 18 conversation — local models fail at multi-step orchestration but are OK at one-shot summarization/classification).
- Endpoint: `http://localhost:11434/v1/chat/completions` (OpenAI-compatible).
- Fallback to a deterministic regex classifier if no local model is reachable (e.g. `/sign[-]?out|logout|delete|cancel|disable|revoke/i` → destructive).

**Safety floor:**
- Always treat as destructive (skip without model): `delete`, `remove`, `cancel`, `disable`, `revoke`, `sign out`, `log out`.
- Confidence threshold for safe-click: ≥ 0.7. Lower → log but skip.
- Limit: at most N safe-clicks per page (default 5) to avoid explosion.

**Acceptance:**
- On the logtrim dashboard, the safe-click pass should newly capture at least one endpoint not visible in a pure BFS run (e.g. an `/approvals/{id}` detail call triggered by a row-expand).
- Sign Out button must NEVER be auto-clicked (verify in `button-classification.json` — should be `destructive`).

**Env vars (proposed):**
- `CLASSIFY_MODEL_URL` (default `http://localhost:11434/v1`)
- `CLASSIFY_MODEL` (default `llama3.1:8b`)
- `SAFE_CLICK_MAX_PER_PAGE` (default `5`)
- `SAFE_CLICK_MIN_CONFIDENCE` (default `0.7`)
- `SAFE_CLICK_DISABLE=1` to skip the safe-click pass entirely.

**Open questions:**
- Should classify-and-click be a single script or two? Two is cleaner (debuggable; safe-click can run on a hand-edited classification file), one is simpler. Lean: two.
- Do we want to feed surrounding DOM context to the model (sibling headings, breadcrumbs) for better classification? Cheap experiment after MVP.

---

## Done

- ✅ Crawlee + Playwright BFS crawler with native network capture (`crawl.mjs`)
- ✅ OpenAPI spec generator (`spec.mjs`) — paths, schemas, sample bodies, redaction
- ✅ Application mindmap + redirect flowchart (`mindmap.mjs`)
- ✅ Aggregated `routes.json` (endpoints, auth, JWT decoded, security headers, perf hotspots, redirects, failed reqs, third-party hosts)
- ✅ Per-page deep `pages.json` (title, meta, headings, forms, clickables, storage, console, websockets, timing, screenshot)
- ✅ `waitForUrlStable` to catch SPA `router.push` redirects
- ✅ `POST_CRAWL_URLS` (visit-after-BFS) and `POST_CRAWL_CLICKS` (click-after-BFS for non-URL actions like Sign Out)
- ✅ Env-configurable login (`LOGIN_URL_REGEX`, `LOGIN_*_SELECTOR`, `LOGIN_SUBMIT_TEXT`) and mindmap (`MINDMAP_ROOT`, `SECTION_RULES`)
- ✅ Auto section-grouping fallback (title-case first path segment) so the mindmap is useful on any app without per-site config
- ✅ Playwright UI test generator (`generator/generator.mjs`) — emits runnable `@playwright/test` specs into `output/crawler/tests/`:
  - `auth.spec.mjs` (login positive + auth-gate negative)
  - `redirects.spec.mjs` (server + client nav redirects, click-based included)
  - `sections/<name>.spec.mjs` (per-page smoke: load + title + no pageerrors + expected backend APIs fired; `expect.soft` for per-API misses, hard fail only if zero fire)
  - `forms.spec.mjs` (form-fill + submit, `.skip` by default — opt-in)
  - Standalone `package.json` + symlinked `node_modules` so tests can either run in-place or be detached and `npm install`-ed
  - All URLs / creds / selectors env-overridable at test runtime (`BASE_URL`, `LOGIN_*`) so the same tests retarget to staging/prod
- ✅ Pipeline runs end-to-end: `npm run all` (crawl → analyze → spec → mindmap → generate) and `npm test` runs the generated tests
- ✅ SSO / OAuth support — intelligent unified login in `crawl.mjs ensureAuthenticated()` (LLM classifies SSO vs normal via `lib/auth-classify.mjs`, fills with LLM-supplied selectors, auto-escalates to a headed browser + pause for MFA/CAPTCHA, saves `storageState`). LLM on by default; `--no-LLM` to disable. (Replaced the old `login-once.mjs` + `--sso`.)
- ✅ Regex-based safe-click pass (`INTERACT_MODE=1`) — after BFS, revisits each captured page, clicks every visible non-form button matching `SAFE_CLICK_REGEX` (default `.+`) AND not matching `DESTRUCTIVE_CLICK_REGEX` (delete/cancel/sign-out/etc), max N per page (`SAFE_CLICK_MAX_PER_PAGE`), navigates back between clicks. Captures new endpoints from row-expand / pagination / tabs / toggles that pure BFS misses. Proven on logtrim: discovered `PATCH /app/v1/patterns/{id}/toggle` + `GET /app/v1/apps/logs/detailed` that BFS alone wouldn't find.
