# P0-01 — Run Spine (`testo run`) · SPEC

**Status:** v1.1 — **implemented** 2026-07-17 (`interfaces/cli/commands/run.mjs`
+ `interfaces/cli/_lib/spine/`; `npm run test:spine`). Stages store/plan/
generate/execute/report are honest placeholders until p0-03 … p0-08 land.
**Depends on:** existing context pipeline (content-extractor → indexer →
synthesizer → gap-analyzer → feature-extractor), existing `testo` CLI skeleton
**Consumed by:** every other P0 component — the spine is what invokes them
**Shared contracts:** run workspace, `run.json`, checkpoint (p0-00 §3, §4, §6)

> The conductor. One command takes a target from nothing to a final report,
> owns the run workspace, sequences the stages, holds the interactive
> checkpoint, and keeps the run record that the transparency report is built
> from. It contains **no intelligence** — no LLM calls, no test logic.

---

## 1. Purpose & Non-Goals

**Purpose.** `testo run <url> [--codebase <path>] [--mode safe|full] [--budget N]`
creates `output/runs/<runId>/`, runs the stages in order —

```
acquire → understand → store → plan → CHECKPOINT → generate → execute → report
```

— recording per-stage status in `run.json`, stopping for exactly one human
decision (the checkpoint), and finishing with the report paths printed.

**Non-Goals.**
- MUST NOT call an LLM or write to `ledger.jsonl` (only reads it, for the
  checkpoint's budget summary).
- MUST NOT contain test-generation, execution, or reporting logic — it invokes
  p0-05/06/07/08 entrypoints and interprets their exit codes.
- MUST NOT read or write anything outside the repo and its run workspace; no
  cross-run reads ever (blank-slate rule, p0-00 §10.3).
- MUST NOT replace `run-pipeline.sh` in P0 — that stays as the dev/stage-toggle
  tool; `testo run` is the product entrypoint.

## 2. CLI

```
testo run <url>
  --codebase <abs path>     enables url+code profile (else url-only)
  --mode safe|full          default safe
  --budget <n>              default 200 (engine requests; RUN_BUDGET in .env)
  --engine claude|mock      default from .env ENGINE_PROVIDER
  --yes                     auto-approve checkpoint (CI/dev only; logged)
  --resume <runId>          re-enter an aborted run at its first non-done stage
  --dry-run                 print the stage plan, run nothing
```

`.env` remains the config source for everything the existing pipeline already
reads (crawler login, TARGET_CODEBASE, etc.); flags override .env for the
run-level keys above.

## 3. Stage sequencing

Each stage = `{ name, entrypoint, args, failMode }`. The spine spawns the
entrypoint (Node in-process import where trivial, child process otherwise),
stamps `stages.<name>` timestamps/status, and honors `failMode`:

| Stage | Wraps | failMode |
|---|---|---|
| acquire | content-extractor run (crawler + code extractors per profile) | **abort** — nothing to test without observations |
| understand | indexer → synthesizer → gap-analyzer → feature-extractor | abort |
| store | p0-03 `build.mjs` | abort |
| plan | p0-05 | **degrade** — template plan on failure |
| checkpoint | built-in (§4) | abort on reject |
| generate | p0-06 per-feature; template fallback per slice | degrade |
| execute | p0-07 | abort (results are the product's substance) |
| report | p0-08 | abort |

"degrade" = record in `run.json.degraded` via the spine's `markDegraded()`
helper and continue with the documented fallback. A stage that is **not
implemented yet** always aborts regardless of its declared `failMode` — there
is no fallback to degrade *to*, and a run that quietly continued would produce
an empty report.

### 3.1 Where the context layer writes (decided 2026-07-17)

New components (p0-03 … p0-08) take `--workspace` and are workspace-native.
The **existing** context-layer components are not: each resolves its own paths
from `__dirname` and writes to `<repo>/output/`. Threading a workspace through
them means editing ~20 working files — including `scripts/`, which `README.md`
marks **UNCHANGED** — plus a Python extractor. Not worth it for P0, which runs
one human-started run at a time.

So: **acquire and understand let those components write to `output/` as they
always have, and the spine snapshots the artifacts into `<workspace>/context/`
once understand completes.** Everything downstream reads only the workspace, so
the blank-slate guarantee holds where it matters.

The risk that buys back is staleness: `output/` is shared, so a component that
fails could leave a *previous* run's artifacts in place and we would index them
as fresh — the failure this project already hit once ("read a stale graph.json
and reported it as fresh"). The spine therefore **asserts freshness instead of
assuming it** (§3.2). Verified beats prevented.

Per-run output isolation (an `outputRoot()` sweep over those components) stays
available as its own later change. It buys concurrent runs; P0 doesn't need them.

### 3.2 Acquire's freshness assertion

After content-extractor exits 0, acquire reads
`output/content-extraction-index.json` and **aborts** unless:

- `generatedAt` is from this run (2s slack for write-time skew), and
- the `crawler` source reports `ok` — a run against a URL whose crawl silently
  failed would otherwise report on a previous run's application.

A non-crawler source that failed is a survivable loss of one perspective:
`markDegraded()` records it, acquire continues, and the report's gap section
discloses it. A **skipped** source (no input for it — e.g. no codebase) is not
a degradation and is not reported as one.

## 4. The checkpoint (the one human gate)

After `plan` succeeds the spine prints a summary and prompts:

```
Plan ready: 6 features, 34 scenarios (28 safe / 6 mutation), est. 40 engine
requests of 173 remaining. Mode: safe — 6 mutation scenarios will be SKIPPED.
Approve and execute? [y/N/e]
```

- `y` — sha256 the plan file, write `checkpoint.{approvedAt,planHash}`, continue.
- `N` (default) — the gate ran and returned a decision, so the checkpoint stage
  itself ends `done`; the run's `outcome` is set to **`declined`** (not
  `aborted` — a declined plan is not a stage *failure*) and the refusal is
  recorded on `checkpoint.{declinedAt,reason}`. Exit 0. No report.
- `e` — open `plan/test-plan.json` in `$EDITOR`; on close, re-validate against
  the plan schema, re-print the summary, re-prompt. Invalid edit → show
  validation errors, re-prompt.
- `--yes` skips the prompt but writes `checkpoint.approvedBy: "--yes flag"` —
  the transparency section discloses auto-approval.

The `planHash` guard: the spine ships `verifyPlanHash(dir, planPath, run)` and
proves it in tests (a plan edited after approval fails the check). It is **not
called during the spine's own flow** — the callers are the `generate` and
`execute` stages, which MUST call it before acting. That wiring lands with
p0-06 / p0-07; until then the mechanism exists but nothing invokes it, because
nothing yet runs after the checkpoint.

## 5. Failure & resume

- Any `abort` leaves `run.json` truthful (stage `failed`, later stages
  `pending`) and exits non-zero. Stage children run with inherited stdio, so
  their output already streamed to the terminal; the spine prints the failing
  stage name + reason (not a re-captured log tail) and the resume hint.
- `--resume <runId>` re-derives config from `run.json` (flags that would change
  a resumed run are a usage error, not a silent override), skips `done` stages,
  and re-runs from the first non-done one. A resume that lands on `generate` /
  `execute` re-verifies `planHash` there (§4) — those stages own the check.

## 6. Acceptance

Status as of the 2026-07-17 build (`npm run test:spine` — 57 tests). Criteria
1 and 3 are **blocked on downstream components by design** (dependency-order
build): they flip green when p0-07/p0-08 replace their placeholders. This is
the two-beat "done" — spine mechanics finished now, full end-to-end later.

1. ⏸ Mock-engine end-to-end (`--engine mock --yes`): every stage `done`, report
   files exist, zero LLM traffic. — *Blocked: store/plan/generate/execute/report
   are placeholders. Today the run reaches `store` and aborts honestly. Partial
   evidence: acquire+understand run for real, workspace + `run.json` are
   produced, dry-run walks all 8 stages.*
2. ✅ Checkpoint interactivity: `N` declines cleanly; `e` round-trips an edit; a
   post-approval plan edit is caught by the hash check. — *`checkpoint.test.mjs`.*
3. ⏸ Kill mid-generate; `--resume` completes without re-running
   acquire/understand/store. — *`generate` is a placeholder, so "mid-generate"
   can't occur yet. The resume mechanism (skip `done` stages, refuse config
   changes, reject unknown/completed/declined runs) is verified now via a
   store-abort → resume path.*
4. ✅ `run.json` after any outcome validates against the p0-00 §4 shape. —
   *`workspace.test.mjs`.*
