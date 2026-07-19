# P0 — Overview, Shared Contracts & Build Order

**Status:** Approved plan (grilled 2026-07-17) — governs specs p0-01…p0-08
**Governing doc:** `docs/harness-use-cases.md` (the use-case catalog and run policies)

> P0 = the smallest run that produces the product: `testo run <url>` against
> logtrim (URL + codebase, safe mode) completing acquire → understand → store →
> plan → **checkpoint** → generate → execute → report, with all four report
> sections populated and every LLM touchpoint carrying a deterministic fallback.

---

## 1. Decisions this plan is built on

| Decision | Choice |
|---|---|
| Engine for development | **Claude Agent SDK / Claude Code headless** (enterprise subscription on this machine) |
| Engine at work (target) | GitHub Copilot SDK — **adapter contract + stub in P0, implementation in P1** |
| Test/CI engine | **mock/replay adapter** (recorded fixtures) — deterministic, credential-free |
| Language split | **All Node.** (Original plan put the agent-session harness in Python; OQ-4 in p0-02, resolved 2026-07-19, showed the `claude` CLI runs the A1 session directly, so C2b is Node too. The only Python left is the pre-existing graphify/extractor island, bridged for S4 via a small CLI — p0-02 §3.4.) |
| Tier-1 routing | S1/S2/S4 single-shot calls go through the **Node model-api-connector**, in-process |
| A1 routing | Per-feature agent session via `runSession()` (Node), driving the `claude` CLI with an MCP config — called in-process by C6 |
| Execution sandbox | **Local child process** with timeout + teardown; executor interface designed for backend swap (Docker/E2B later) |
| S3 (Jira/Confluence) | **Deferred to P1.** Built fixtures-first; config-swappable to a real instance |
| Persistence | Blank slate per run; within-run content-hash caching only |
| Context-layer outputs | Existing components keep writing to `output/`; the spine snapshots into `<workspace>/context/` after understand, and asserts acquire freshness. New components are workspace-native. See p0-01 §3.1 |
| Report | Self-contained HTML + PDF export, both in the run workspace |
| Acceptance target | logtrim, URL+codebase profile, safe mode |

## 2. Component map and build order (dependency order, full components)

| Order | Spec | Component | Side |
|---|---|---|---|
| 1 | p0-01 | Run spine — `testo run`, workspace, checkpoint, ledger | Node |
| 2 | p0-02 | Engine layer — single-shot `complete()` + agent-session `runSession()` (both Node) | Node |
| 3 | p0-03 | Per-run knowledge store (component 5-lite) + S2 residue match | Node |
| 4 | p0-04 | Context-server MCP (component 6) | Node |
| 5 | p0-05 | Test-plan-creator (S1) | Node |
| 6 | p0-06 | Generation stage (A1 via runSession) + S4 re-route (+ bin/complete.mjs bridge) | Node |
| 7 | p0-07 | Execution stage — real test-executor, safe/full enforcement | Node |
| 8 | p0-08 | Final report — four sections, HTML + PDF | Node |

Each spec repeats only its own contracts; everything two or more components
touch is defined **here, once**.

---

## 3. Shared contract — the run workspace

Everything a run produces lives under `output/runs/<runId>/` and is disposable.
`runId` = `<yyyymmdd-HHmmss>-<slug(target host)>`.

```
output/runs/<runId>/
├── run.json             run record: config, stages, degradation, checkpoint
├── ledger.jsonl         every engine call, append-only (§5)
├── cache/               content-hash cache for Tier-1 calls (this run only)
├── context/             stage outputs: sources index, facts, gaps, features
├── store/knowledge.json the C3 store (p0-03)
├── plan/test-plan.json  the C5 plan — subject of the checkpoint (§6)
├── tests/               generated tests + manifest.json (§7)
├── results/             executor output: results.json + artifacts (§8)
└── report/              index.html + report.pdf (p0-08)
```

## 4. Shared contract — `run.json`

```jsonc
{
  "runId": "20260717-091500-logtrim",
  "createdAt": "<ISO8601>",
  "target": { "url": "https://…", "codebasePath": "/abs/path | null" },
  "profile": "url-only | url+code",           // derived from target
  "mode": "safe | full",                       // default safe
  "budget": { "maxRequests": 200 },            // per-run engine-call cap
  "engine": { "provider": "claude | mock | copilot" },
  "outcome": "completed | aborted | declined | null",  // null = in flight or killed
  "endedAt": "<ISO8601>|null",
  "stages": {                                  // written by the spine only
    "acquire":    { "status": "pending|running|done|failed|skipped", "startedAt": null, "endedAt": null },
    "understand": { "…": "…" }, "store": {}, "plan": {},
    "checkpoint": {}, "generate": {}, "execute": {}, "report": {}
  },
  // A declined checkpoint is NOT a failed stage — the gate ran and returned a
  // decision. It ends `done`, and the refusal is recorded here + in `outcome`.
  "checkpoint": { "approvedAt": "<ISO8601>|null", "planHash": "sha256:…",
                  "approvedBy": "operator | --yes flag",
                  "declinedAt": "<ISO8601>|null", "reason": "…" },
  "degraded": [                                // one entry per fallback taken
    { "useCase": "S1", "stage": "plan", "reason": "engine unavailable",
      "fallback": "template scenarios", "at": "<ISO8601>" }
  ]
}
```

Rules: only the spine (p0-01) writes `stages` and `checkpoint`; any component
MAY append to `degraded` via the spine's helper. A run whose engine never
answers still ends `status: done` on every stage — degraded, not failed.

## 5. Shared contract — `ledger.jsonl`

One JSON object per line, one line per engine call (cache hits included).
Writers: the Node connector — `complete()` (`caller:"connector"`) and
`runSession()` (`caller:"session"`), both in p0-02. Append-only, no
rewrites; the transparency report section (p0-08) and the budget check both
read this file.

```jsonc
{ "ts": "<ISO8601>", "useCase": "S1|S2|S4|A1", "caller": "connector|session",
  "engine": "claude|mock", "model": "<reported model id>",
  "requests": 1, "inputTokens": 1234, "outputTokens": 567,
  "cacheHit": false, "degraded": false, "durationMs": 2100,
  "note": "feature=checkout scenario ideation" }
```

Budget rule: before any engine call, the caller sums `requests` over the
ledger; at or above `budget.maxRequests` it MUST take its deterministic
fallback and record a `degraded` entry instead of calling.

## 6. Shared contract — `plan/test-plan.json`

```jsonc
{
  "runId": "…", "createdAt": "<ISO8601>",
  "source": "llm | template",                 // template = S1's fallback path
  "features": [ {
    "featureId": "feat:checkout", "name": "Checkout",
    "scenarios": [ {
      "scenarioId": "sc-0042",
      "title": "cart survives login redirect",
      "kind": "api | ui | perf",
      "intent": "<one-sentence test intent>",
      "mutation": false,                      // POST/PUT/DELETE or writing form?
      "targets": { "endpoints": ["GET /api/v2/cart"], "pages": ["/cart"] },
      "priority": 1,                          // from gap severity
      "gapRefs": ["gap:…"]                    // gaps this scenario addresses
    } ]
  } ],
  "estimates": { "scenarios": 34, "llmRequests": 40 }
}
```

`mutation` is load-bearing: the checkpoint summary counts it, and the executor
enforces safe mode from it. A scenario with unknown mutation status MUST be
marked `"mutation": true` (fail safe).

## 7. Shared contract — `tests/manifest.json`

The bridge between generation and execution. Generators (agent or template)
append; the executor consumes. A test file not in the manifest does not run.

```jsonc
{ "runId": "…", "entries": [ {
    "scenarioId": "sc-0042", "featureId": "feat:checkout",
    "file": "tests/feat-checkout/sc-0042.spec.mjs",
    "kind": "ui", "mutation": false,
    "generator": "agent | template",
    "status": "generated | failed-generation"
} ] }
```

## 8. Shared contract — `results/results.json`

```jsonc
{ "runId": "…", "summary": { "passed": 0, "failed": 0, "skippedMutation": 0, "error": 0 },
  "entries": [ {
    "scenarioId": "sc-0042", "file": "…", 
    "status": "passed | failed | skipped-mutation | error",
    "durationMs": 8400,
    "artifacts": { "screenshots": ["results/shots/sc-0042-1.png"], "log": "results/raw/sc-0042.log" }
} ] }
```

## 9. Safety floor (all modes, enforced in code, not by any LLM)

Regex on scenario title + intent + target endpoint path/method:

```
/\b(delete|remove|destroy|revoke|disable|deactivate|sign[ -]?out|log[ -]?out|cancel)\b/i
```

Matching scenarios are never auto-executed — in **either** mode — unless the
operator lists the specific scenarioId in `SAFETY_ALLOWLIST` (.env). Safe mode
additionally skips every `mutation: true` entry (status `skipped-mutation`).
This floor pre-dates and outranks S7 button classification (P1).

## 10. P0 acceptance (the definition of done)

1. `testo run <logtrim-url>` with `TARGET_CODEBASE` set and
   `ENGINE_PROVIDER=claude`: full run, interactive checkpoint approved in
   terminal, all stages `done`, report contains **all four sections** with
   real content, `ledger.jsonl` shows S1/S2/S4/A1 calls, safe mode visibly
   skips mutation scenarios and the report's gap section says so.
2. Same command with `ENGINE_PROVIDER=mock` and no fixtures (simulated engine
   outage): the run **still completes** — template plan, template generation,
   store built without S2 merges — and the transparency section lists every
   degradation. A report always comes out.
3. Re-running creates a new `output/runs/<runId>/` with zero reads from any
   previous run (blank slate audit: grep the code for cross-run paths).

## 11. Out of P0 (recorded so nobody re-litigates silently)

S3 Jira/Confluence (P1, fixtures-first), S5 heal, S6 mock data, S7 button
classification (all P1), S8 feature naming (P2), Copilot adapter
implementation (P1 — contract + stub only in P0), Docker/E2B executor
backends, qa-bot, Code Mode, cross-run persistence, embeddings.
