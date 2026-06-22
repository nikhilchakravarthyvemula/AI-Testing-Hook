# Module 3 — Agentic Execution (self-healing, action cache, hooks)

_Borrowed from: vostride/agent-qa. Target: **Execution Layer** (+ Generation helpers)._

## Goal

Make execution robust instead of brittle. Port the four ideas that agent-qa has and the harness doesn't: **self-healing execution** (recover from UI drift mid-run), an **action/plan cache** (skip planner work on repeat runs), **execution memory** (learn from healed steps), and **sandboxed hooks** (fixtures/teardown in containers). Along the way, actually build the Execution Layer, which is currently 100% planned.

## Current state (verified)

- `execution-layer/` contains **only `README.md`** — `test-executor/` and `report-generator/` don't exist. There is no Playwright invocation, no results parsing, no dashboard. Nothing to hook into; it's a greenfield build.
- Working generators live in `scripts/crawler/generator/`: `generator.mjs` (smoke: auth, redirects, per-section) and `e2e.mjs` (deep: flows, per-API, auth-gate, forms). They write a self-contained `tests/` tree: `playwright.config.mjs`, `helpers/config.mjs`, `helpers/login.mjs` (exports `login`, `trackApiCalls`, `trackConsoleErrors`, `fillField`), `sections/*.spec.mjs`, `e2e/`.
- Generated specs use raw Playwright locators: `page.goto`, `page.locator(sel).first().click()`, `.fill()`, `getByPlaceholder`, `getByLabel`, `waitForURL`, `waitForResponse`, `expect`/`expect.soft`, and `context.request.get/post`. **A single changed selector fails the test** — no recovery.
- `generation-layer/test-script-generator/` is an **empty stub**; the real generators are under `scripts/crawler/`.
- LLM seam for Node: `infrastructure/model-api-connector` — `getClient(provider, opts)` → `client.chat({ messages, model, temperature, maxTokens, … }) → { content, finishReason, usage, raw }`. **Only `minimax` is implemented; no streaming.**
- `interactions.json` (240 records) carries an `elementSignature`; `pages.json` carries `clickables.{buttons,links}` with text/selectors — ideal keys/hints for healing + caching.
- `testo` registers `scan`, `generate` (api-tests only), `ask`. `run`, `report`, `plan` are noted as not-yet-registered.
- `infrastructure/container-deploy/` is **empty**. The only Docker artifact in the tree is vendored: `…/openharness/sandbox/Dockerfile` (py3.11-slim with bash/git/ripgrep) — reusable as the hook sandbox base.
- `api-test-generator` is deterministic curl-based; `openapi-test-gen` uses `fetch()` + a headless Chromium to capture a fresh Bearer token from `output/crawler/auth-state.json`.

## Architecture

```
testo run → execution-layer/test-executor
                ├─ hooks(beforeAll)  ─ sandboxed (docker) ─┐
                ├─ playwright test  (UI specs use heal.mjs)│   results → output/execution/results.json
                ├─ api-test-generator skill (curl)         │   heals   → output/execution/heal-events.json
                ├─ hooks(afterAll)  ─ sandboxed ───────────┘   traces  → output/execution/traces/
                ▼
           flake manager (retry-once) → report-generator → output/execution/report.html

heal.mjs:  primary selector → [fail] → action-cache → [miss] → LLM(model-api-connector) → retry → write cache + heal-event
heal-events.json → (Module 2 distiller) → memory/skills/*.md → (next run) memory/select → healer tries learned fix first
```

Self-healing is **flag-gated and deterministic-first**: a green run never calls the LLM. Healing recovers from *drift* and is always *surfaced* (a healed step marks the run `degraded`, not silently `passed`) so genuine regressions aren't masked.

## New files (file-by-file plan)

| Path | Lang | Role |
|---|---|---|
| `tests/helpers/heal.mjs` (emitted by generator) | node | `healClick/healFill/healLocator(page, intent, hints)` — try → cache → LLM → retry → record |
| `execution-layer/test-executor/run.mjs` | node | Orchestrate hooks + `playwright test` (json reporter) + api skill; normalize into `results.json`; flake retry |
| `execution-layer/test-executor/lib/heal-engine.mjs` | node | DOM snapshot (roles/labels/text), LLM locator inference, cache R/W, heal-event emit |
| `execution-layer/test-executor/lib/flake.mjs` | node | Retry-once policy; classify `passed`/`failed`/`flaky`/`degraded` |
| `execution-layer/hooks/run-hook.mjs` | node | Run one hook in a Docker sandbox; capture structured stdout |
| `execution-layer/report-generator/build.mjs` | node | Unified HTML dashboard (reuse `graph-viewer/lib/render-html.mjs` styling) |
| `infrastructure/container-deploy/Dockerfile.hooks` | — | Hook sandbox image (base on vendored openharness sandbox: py3.11-slim + node + bash) |
| `infrastructure/container-deploy/README.md` | md | Build/run instructions |
| `interfaces/cli/commands/run.mjs` | node | `testo run` → test-executor |
| `interfaces/cli/commands/report.mjs` | node | `testo report` → report-generator |

**Edited files:**

| Path | Change |
|---|---|
| `scripts/crawler/generator/generator.mjs` & `e2e.mjs` | Emit `heal*()` calls instead of raw `locator().click()/.fill()`; add `['json', {outputFile}]` reporter; emit `tests/helpers/heal.mjs` |
| `infrastructure/model-api-connector/providers/` | Add `openai.mjs`, `anthropic.mjs`, `ollama.mjs` so healing isn't locked to minimax (BYO-LLM parity) |
| `interfaces/cli/testo.mjs` | Register `run`, `report` |

## Capability 1 — Self-healing execution

Generator change (UI specs). Instead of:

```js
await page.locator('button.nav-insights').first().click();
```

emit a healable call carrying everything the click-graph already knows about that intent:

```js
import { healClick } from '../helpers/heal.mjs';
await healClick(page, 'open-insights', {
  selector: 'button.nav-insights',     // primary (from crawl)
  role: 'link', name: 'Insights',      // accessible fallback
  text: 'Insights', via: 'button',     // from intent node
});
```

`heal.mjs` (core):

```js
import { getClient } from '../../infrastructure/model-api-connector/index.mjs';
import { cacheGet, cachePut, recordHeal } from './heal-store.mjs';

export async function healClick(page, intent, hints) {
  const loc = await resolve(page, intent, hints);
  await loc.click();
}

async function resolve(page, intent, hints) {
  // 1. deterministic-first: primary selector, then accessible role/name, then text
  for (const cand of [hints.selector && page.locator(hints.selector),
                      hints.role && page.getByRole(hints.role, { name: hints.name }),
                      hints.text && page.getByText(hints.text, { exact: false })]) {
    if (cand && await cand.count()) return cand.first();
  }
  if (process.env.HEAL !== '1') throw new Error(`locator not found for intent '${intent}'`);

  // 2. action cache (no LLM)
  const sig = sigOf(page, intent);
  const cached = cacheGet(sig);
  if (cached && await page.locator(cached.selector).count()) return page.locator(cached.selector).first();

  // 3. LLM inference from a compact accessibility snapshot
  const snap = await snapshot(page);                       // [{role,name,text,testid,selector}]
  const llm = getClient(process.env.HEAL_PROVIDER || 'minimax');
  const { content } = await llm.chat({ temperature: 0,
    messages: [{ role: 'user', content: HEAL_PROMPT(intent, hints, snap) }] });   // → {"selector": "..."}
  const sel = JSON.parse(content).selector;
  const found = page.locator(sel);
  if (!await found.count()) throw new Error(`heal failed for intent '${intent}'`);

  cachePut(sig, { selector: sel });                        // remember for next run
  recordHeal({ intent, from: hints.selector, to: sel, page: page.url() });  // → heal-events.json (Module 2)
  return found.first();
}
```

For **API specs**, "healing" is lighter and mostly deterministic: on an unexpected status, refresh auth (reuse `api-test-generator/lib/login_flow.py`) and/or re-synthesize the body (`request_synth.py`), retry once, and emit a heal-event. No LLM needed in v1.

## Capability 2 — Action / plan cache

`output/execution/action-cache.json`:

```json
{ "version": 1, "entries": {
  "sig:auth.superalign.ai|/insights|open-insights": {
    "selector": "a[href='/insights']", "role": "link", "name": "Insights",
    "confirmedRuns": 4, "lastOk": "2026-06-05T07:40Z", "origin": "heal" }
} }
```

Key = `hash(target, pageKey, intent)`, seeded from `interactions.json#elementSignature`. The healer checks the cache before the LLM (step 2 above); a cache hit means **zero token cost** on repeat drift. A coarser **plan cache** keyed by `(target, route)` stores validated section/e2e step lists so the future `test-plan-creator` can skip re-deriving a plan that already passed — agent-qa's "reuse validated plans across similar runs."

## Capability 3 — Execution memory (shared with Module 2)

Do **not** build a second memory. `heal-events.json` is the write feed into Module 2's `skill-distiller`, which turns a heal into a durable Markdown skill (e.g. *"on `/insights`, 'Insights' nav moved from `button.nav-insights` → `a[href='/insights']'"*). Before the next run, `memory/select.py(target, page)` surfaces those learnings so the healer's deterministic step can try the learned selector *first*. Two layers: **action-cache** (fast, structured, exact) + **skill-memory** (durable, semantic, cross-run). This is the convergence point of agent-qa and Acontext.

## Capability 4 — Sandboxed hooks

`hooks.yaml` (per suite, referenced by the test plan):

```yaml
beforeAll:  { runtime: python, script: hooks/seed_db.py,  timeout: 60, passOutputAs: env }
afterEach:  { runtime: bash,   script: hooks/reset.sh,    timeout: 20 }
afterAll:   { runtime: node,   script: hooks/teardown.mjs, timeout: 60 }
```

`run-hook.mjs` executes each in a container and captures structured output back into the run:

```js
execFileSync('docker', ['run', '--rm', '--network', process.env.HOOK_NET || 'none',
  '-v', `${workdir}:/work`, '-w', '/work', IMAGE,
  runtimeCmd(hook.runtime), hook.script], { timeout: hook.timeout * 1000 });
// stdout last line = JSON → merged into run context (fixtures, ids, tokens)
```

Base the image on the vendored `openharness/sandbox/Dockerfile` (py3.11-slim + bash/git/ripgrep; add Node). This finally gives `infrastructure/container-deploy/` a reason to exist. Hooks are **optional** — absent `hooks.yaml`, the executor runs exactly as today.

## The Execution Layer itself

- `test-executor/run.mjs`: run `beforeAll` hooks → `npx playwright test` (now with `['json', {outputFile:'output/execution/ui-results.json'}]`) → `api-test-generator` skill → `afterAll` hooks. Normalize UI + API into one `output/execution/results.json` (superset of the existing `TestResult` shape, plus `healed: bool`, `heals: []`, `flaky: bool`). Collect Playwright traces/screenshots to `output/execution/traces/`.
- `flake.mjs`: retry failed tests once; `passed→failed` stays failed, `failed→passed` = `flaky`, healed-but-passed = `degraded`.
- `report-generator/build.mjs`: one self-contained HTML (reuse `render-html.mjs`): latest run pass/fail/flaky/degraded, **heal events as warnings**, Module 1 `gaps.json`, and a coverage matrix (features × tested?). 

## Integration points

- **testo** — `testo run [--heal] [--strict]` → executor; `testo report` → dashboard. `generate` already exists for specs.
- **Generation** — generators consume click-graph intent nodes (`humanLabel`, `text`, `via`, `selector`) as `hints`; this is why healing is cheap — the crawl already captured the fallbacks.
- **Module 1** — executor reads `graph-analytics.json#ranking` to run highest-risk specs first / `--only-top N`.
- **Module 2** — `heal-events.json` → distiller; `memory/select.py` → healer pre-seed.
- **model-api-connector** — healer's only LLM dependency; add providers so healing honors BYO-LLM.

## Build vs borrow — and the license gate

agent-qa is the closest thing to *what you're building*, and it also does **mobile (Appium)** and **subscription-auth BYO-LLM (Codex/Claude Code)** — both of which would be large independent efforts to build. So seriously weigh **adopting agent-qa's runtime** for the Execution Layer rather than porting.

**But verify the license first.** Despite "open-source" wording, the repo is tagged `fair-source` and `fsl` (Functional Source License) — **not** OSI-approved open source; FSL typically restricts competing/commercial use for a period before converting to open. **Read `LICENSE.md` before pulling any agent-qa code into a commercial product.** Contrast: NetworkX (BSD, Module 1) and Acontext (Apache-2.0, Module 2) are safe to vendor today. Decision gate: if the FSL terms fit your use → adopt its runtime and skip most of this module; if not → port the four capabilities above.

## Acceptance tests

1. **Healing works and is the cause** — rename a selector in a generated section spec. `HEAL=0` → the spec fails. `HEAL=1` → it recovers in-run, passes as `degraded`, and writes a `heal-events.json` entry.
2. **Cache avoids the LLM** — run #2 with the same break hits `action-cache.json` (assert the model-api-connector is *not* called; log shows `cache-hit`).
3. **Memory closes the loop** — the heal-event distills into a `memory/skills/*.md` (Module 2), and run #3 resolves the moved element via the learned selector on the deterministic path.
4. **Hooks** — a `beforeAll` python hook seeds a fixture in a container; the test sees it; `afterAll` tears down; `docker ps -a` shows no leftover container (`--rm`).
5. **Unified results** — `output/execution/results.json` contains both UI and API results with `healed`/`flaky`/`degraded` flags; `flake.mjs` marks a pass-on-retry as `flaky`.
6. **Report** — `testo report` emits one HTML showing pass/fail/flaky/degraded, heal warnings, and `gaps.json`.
7. **Regression not masked** — a deleted feature (element truly gone, not moved) does **not** heal: the healer exhausts candidates and the test fails (healing must distinguish drift from breakage).

## Phasing

- **P0 (decision)** — license-check agent-qa; decide adopt-vs-port. ~1 day, gates everything below.
- **P1** — build the Execution Layer skeleton: `test-executor/run.mjs` (json reporter + unified results) + `flake.mjs` + `testo run`/`report`. (No healing yet — just a real runner. ~1 week.)
- **P2** — `heal.mjs` + `heal-engine.mjs` + action cache + generator emits healable calls + connector providers. (~1.5–2 weeks.)
- **P2** — wire heal-events into Module 2; pre-seed healer from memory.
- **P3** — sandboxed hooks + `container-deploy`. NL test authoring (`testo generate ui-tests --nl "…"`) as an optional headline feature.

## Risks / watch-outs

- **Healing can mask regressions** — the #1 QA risk. Always surface heals (`degraded`, warnings in report); offer `HEAL_STRICT=1` to convert heals into soft failures in CI. Never let a healed run report a clean green.
- **Nondeterminism / token cost** — deterministic-first + action cache keep the LLM off the happy path; cap heal attempts per test.
- **minimax-only connector** — healing is currently locked to one vendor and has no streaming; add providers before relying on it.
- **Docker dependency** — hooks require Docker (as agent-qa does); keep hooks optional so the core runner works without it.
- **License** — the gate above. Do not skip it.
