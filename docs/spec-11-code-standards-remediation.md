# Spec 11 — Code-standards remediation plan

_Target: `docs/spec-11-code-standards-remediation.md`. Source: multi-agent coding-standards review of 2026-07-14 (5 area reviewers → per-file adversarial verification; 45 findings confirmed out of 49 raw). Areas covered: `testo/` (REPL + harness + skill-register + model-api-connector), `context-layer/` (extractors + indexer + crawler generator + llm-advisor), `generation-layer/` (gen.mjs generators + api-test skill)._

> **TL;DR** — Five work packages, ordered by risk: **WP1 secrets** (passwords currently leak
> via stdout, process argv, and a generated shareable file), **WP2 crash/hang fixes**
> (trivially reachable inputs kill the REPL or hang a pipeline), **WP3 wrong-data and
> lying-failure fixes** (indexer silently emits nulls/zeros; several errors masquerade as
> success), **WP4 consolidation** (7 duplicated env loaders, duplicated parsers/loaders,
> hardcoded venv paths — ~⅓ of all findings share this root cause), **WP5 low cleanup**.
> Estimated ~4–5 focused days total; WP1+WP2 are the "do now" half-day-plus-day.

---

## 1. Review method & result

- 5 parallel reviewers (testo REPL · Python packages · context-layer extractors/indexer ·
  LLM plumbing/generators · cross-cutting consistency), each capped at findings that
  *matter* (no formatter-fixable style nits).
- Every finding then adversarially verified per file against the actual code; refuted
  findings dropped. **45 confirmed / 49 raw** → 8 high · 23 medium · 14 low.
- Line numbers below are as of 2026-07-14 (branch `hsbc_demo`); re-locate by symbol if
  the file has drifted.

---

## 2. WP1 — Secrets discipline (HIGH · ~0.5 day)

**Rule to adopt: credentials live in env, are modeled as secrets, and are never printed
or serialized.** Three leaks, three different channels:

| # | Location | Leak | Fix |
|---|---|---|---|
| 1 | `testo/harness/agentic_harness/services/tool_service.py:53` (+ `_log_tool_started`) | `invoke_direct` prints full args repr → **`login_password` in cleartext on stdout** every crawler run | Model secret fields as pydantic `SecretStr` (repr auto-redacts) or redact a `SECRET_FIELDS` set before any print |
| 2 | `context-layer/content-extractor/crawler/generator/generator.mjs:94-95` | Real `LOGIN_EMAIL`/`LOGIN_PASSWORD` serialized as plaintext literals into generated `tests/helpers/config.mjs` — a non-gitignored dir designed to be detached and shared | Emit `process.env.LOGIN_PASSWORD \|\| ''` with **no baked value** (match ui-test-generator's env-at-runtime pattern) |
| 3 | `testo/repl.py:400` (`_generate`) | Password passed as subprocess **argv** token — visible in `ps` to any local user (`_scan` already correctly uses env, :267) | Pass via `LOGIN_PASSWORD` env; skill reads env when the flag is absent |

**Verify:** run a scan + generate with dummy creds; `grep -r "<dummy-password>"` over
terminal capture, `output/`, and `tests/` → zero hits; `ps` snapshot during `/generate`
shows no password.

---

## 3. WP2 — Crash & hang fixes (HIGH/MED · ~1 day)

| # | Location | Bug | Fix |
|---|---|---|---|
| 1 | `testo/repl.py:228, 374` | Both hand-rolled flag parsers read `tokens[i]` unbounded — `/scan --url` (trailing flag) raises IndexError and **kills the REPL** | Extract ONE shared bounds-checked flag parser used by `_scan` and `_generate`; print "missing value for --X" and abort (feeds WP4 #2) |
| 2 | `testo/repl.py:209` (`_spawn`) | Ctrl-C during `/scan`//`/generate` re-raises with no catcher → REPL tears down with a traceback (`turn()` recovers; slash paths don't) | Catch `KeyboardInterrupt`/`CancelledError` around `slash()`; print "interrupted", return to prompt |
| 3 | `testo/harness/agentic_harness/tools/subprocess_stage.py:88` | asyncio default 64 KiB line limit — one long child-stdout line raises out of `pump()`, child left undrained/blocked | `limit=2**20` on `create_subprocess_exec`; wrap the gather in try/finally that kills + awaits the child |
| 4 | `testo/harness/agentic_harness/tools/graphify/tool.py:410` | `finally` uses `move_note` assigned only inside the `try` (:403) → `UnboundLocalError` masks the real error | Initialize `move_note = ""` before the try (next to `combined_log`, :258) |
| 5 | `context-layer/content-extractor/graphify/extract.mjs:110` | Unguarded `JSON.parse(graph.json)` — malformed file crashes before bundle.json is written (every other failure path writes ok=false) | try/catch → ok=false + error, fall through to bundle write |
| 6 | `context-layer/content-extractor/mock-data/extract.mjs:247` | Regexes built from crawler-observed URL paths without escaping — `(` or `+` in a URL throws; `.` over-matches | Escape literal segments before substituting param groups (or try/catch + skip) |
| 7 | `testo/model-api-connector/providers/minimax.mjs:125` | `clearTimeout` fires when headers resolve → body read is unbounded; stalled body hangs `chat()` forever | Clear the timer only after the body is fully read |

**Verify:** `/scan --url` (no value) and Ctrl-C mid-`/scan` leave the REPL alive; feed a
URL containing `(` into mock-data via a crafted bundle; truncate graph.json and re-run
the wrapper → bundle written with ok=false.

---

## 4. WP3 — Wrong data & failures that lie (HIGH/MED · ~1 day)

**Silent-wrong-data (indexer ↔ crawler shape mismatches — nothing enforces a schema):**

| # | Location | Bug | Fix |
|---|---|---|---|
| 1 | `context-layer/indexer/topics/pages.mjs:31` | Reads `page.dom?.title`; crawler writes `title` top-level → **every indexed page title is null** (all 122 pages in the real bundle) | `title: page.title` (click-graph.mjs already does this) |
| 2 | `context-layer/indexer/topics/pages.mjs:34` | Treats `clickables` (`{buttons,links}`) as an array → `clickableCount` always 0 | `(buttons?.length ?? 0) + (links?.length ?? 0)` |
| 3 | `context-layer/indexer/topics/apis.mjs:91` | Treats `samples` (an int) as an array → `sampleCount` always 0 | `ep.samples ?? 0` |
| 4 | `context-layer/content-extractor/graphify/extract.mjs:121` | Graphify stamps `target` as a bare string; the other 3 extractors emit `{baseUrl}` → `target` type flips across indexed output | Normalize the shape across the 4 extractors (or coerce in `loadAllSources`) |

**Failures masquerading as success:**

| # | Location | Bug | Fix |
|---|---|---|---|
| 5 | `context-layer/content-extractor/graphify/extract.mjs:98` | Freshness guard only fires when graph.json exists-but-stale; a run that writes **nothing** reports ok=true/stats=null, exit 0 | else-branch: ok && !exists → ok=false + error before the bundle write |
| 6 | `testo/repl.py:485` (`/clear`) | Swallows `eng.clear()` failure then prints "conversation cleared" | Warn + skip the success message on exception |
| 7 | `testo/harness/agentic_harness/services/harness_service.py:91` | Keyed backend with unset env var silently sends the literal placeholder ("ollama") as the API key → opaque provider 401 | Raise `MissingApiKeyError` (already exists) when config isn't keyless and env is empty |
| 8 | `testo/harness/bin/call_tool.py:165` | Bad tool args raise a traceback + exit 1, violating the documented exit-2 contract (diverges from `call_skill.py`) | `return 2` after the stderr print |
| 9 | `testo/harness/bin/ask.py:75` | Catches only `UnknownToolError`; `ToolSourceMissingError` crashes every default run | Catch the `ToolError` base (call_tool.py:154 handles it cleanly) |
| 10 | `testo/harness/agentic_harness/tools/stage_tools/crawler_tool.py:16` + `code_extractors_tool.py:20` + `graphify/tool.py:199` | The 3 LLM-facing args models omit the repo-wide `extra="forbid"` → hallucinated keys silently dropped | `model_config = ConfigDict(extra="forbid")` on all three |
| 11 | `generation-layer/perf-test-generator/gen.mjs:70, 285` | JTL CSV split on bare commas — quoted fields shift the `success` column → **understated error rate** | Minimal quoted-CSV field splitter in both spots |
| 12 | `generation-layer/perf-test-generator/gen.mjs:98` | `scenario.baseUrl` gets no env substitution (ui-test-generator has `subst()`) → `"$BASE_URL"` targets the literal string | Apply the same `subst()`; share it between the generators (feeds WP4) |
| 13 | `testo/harness/agentic_harness/services/tool_service.py:130` | `invoke_via_free_agent` mutates shared `self._harness` across awaits — concurrent invocations cross-wire | Pass the harness as an explicit parameter to `_consume_agent_stream` |
| 14 | `testo/repl.py:82` | `_SCAN_HELP` directs users to `/crawl`, which was removed | Delete the sentence (or re-add `/crawl` — decided: delete) |

**Verify:** re-run indexer against the existing bundle → titles non-null, clickable/sample
counts non-zero, `target` shape uniform; wipe graphify output + run wrapper → ok=false;
unset MINIMAX_API_KEY → clean `MissingApiKeyError`, not a 401.

---

## 5. WP4 — Consolidation (systemic · ~1–1.5 days)

Copy-paste is the root cause of ~⅓ of the report. One shared-helpers pass:

| # | Duplication | Sites | Consolidate into |
|---|---|---|---|
| 1 | **.env loader ×7** (with live divergence: Python copies clobber empty-string shell exports; llm-advisor's JS copy strips quotes differently) | `testo/bootstrap.py:25`, `testo/harness/bin/ask.py:30`, `bin/call_tool.py:39`, `testo/skill-register/bin/call_skill.py:32`, `graphify/tool.py:58`, `graphify/agent.py:98`, `crawler/llm-advisor/index.mjs:31` | Python: new `testo/_lib/env.py` (mirror `load-env.mjs` semantics, aligned empty-value behavior). JS: llm-advisor imports `testo/_lib/load-env.mjs` |
| 2 | **Flag parser ×2** (same IndexError bug in both) | `repl.py` `_scan` + `_generate` | One `_parse_flags(tokens, spec)` helper (done as part of WP2 #1) |
| 3 | **`--key value` extras parser ×2** | `call_tool.py`, `call_skill.py` | Shared bin helper |
| 4 | **Dynamic module loader ×2** — prepends source dir to `sys.path[0]` permanently (graphify's dir contains `agent.py`, shadowing imports) and skips `sys.modules` registration (reload → duplicate class objects) | `tool_registry.py:112`, `skill_registry.py:81` | One loader: register under synthetic name in `sys.modules`; remove the path insertion after `exec_module` |
| 5 | **Graphify-venv python path ×5** (+ `_lib/.venv` python ×2) — next folder move breaks all at once | `llm_detector.py:53`, `db-schema/llm/extract.py:39`, `repl.py:410`, `graphify/extract.mjs:81`, `testo/testo:7` | One shared constant per language + `GRAPHIFY_PYTHON` env override |
| 6 | **`subst()` env substitution** | ui-test-generator has it; perf-test-generator doesn't | Move to a shared generation-layer helper (WP3 #12) |
| 7 | **URL path resolver ×2** | `api-test-generator/skill.py:402` self-admits copying `curl_builder._resolve_path_params` | Export + reuse the curl_builder helper |

**Verify:** grep proves one definition each (`_load_repo_env`, venv path literal, extras
parser); REPL + ask.py + call_tool.py + call_skill.py all still boot and read `.env`
(including an `EMPTY=` line behaving the same in Python and JS).

---

## 6. WP5 — Low-severity cleanup batch (~0.5 day)

| Location | Issue → fix |
|---|---|
| `testo/repl.py:16` | Docstring omits `/scan` `/generate` `/run` → update (or point at `/help`) |
| `testo/repl.py:145` | Banner hardcodes toolbelt size `8 + len(custom)` → compute from `len(standard_tools())` |
| `testo/repl.py:439` | Slash commands reach into private `harness._engine` → add `set_model()`/`clear()` passthroughs on `AgenticHarness` |
| `testo/harness/bin/call_tool.py:147` | `--key value` extras silently dropped in agent modes → reject (exit 2) or fold into prompt |
| `testo/harness/agentic_harness/exceptions.py:26` | `BackendDisabledError` unreachable → delete or implement |
| `context-layer/content-extractor/openapi-probe/extract.mjs:9` | Header claims TARGET_URL wins; code is the reverse → fix comment |
| `context-layer/content-extractor/run.mjs:160,165` | Wipe list contains paths nothing writes → delete both entries |
| `context-layer/content-extractor/run.mjs:278-281` | Unreachable ONLY-filter branch (would double-push a RUNS record) → delete |
| `context-layer/content-extractor/crawler/extract.mjs:11,23` | Duplicate "moved out of scripts/" comment; `CRAWLER_OUT`/`OUT_DIR` same path twice → collapse |
| `context-layer/scan.mjs:7` | Header says "only content-extractor exists"; STAGES runs three → update |
| `testo/model-api-connector/providers/minimax.mjs:30` | Sync `mkdirSync`+`appendFileSync` per LLM call → mkdir once at load; async append (or drop the sink) |
| `testo/model-api-connector/providers/minimax.mjs:68` | Unknown `MINIMAX_REGION` silently falls back to global → throw, listing supported values |
| `context-layer/content-extractor/crawler/llm-advisor/index.mjs:60` | Missing-key warning re-emitted per decision (hundreds/crawl) → cache failed state, warn once |
| `generation-layer/api-test-generator/skill.py:402` | (WP4 #7) duplicated path resolver → reuse curl_builder helper |

---

## 7. Order & effort

| WP | Theme | Effort | Depends on |
|---|---|---|---|
| WP1 | Secrets | ~0.5 d | — |
| WP2 | Crash/hang | ~1 d | — (WP2 #1 creates the parser WP4 #2 names) |
| WP3 | Wrong data / lying failures | ~1 d | — |
| WP4 | Consolidation | ~1–1.5 d | easiest after WP1-3 (touches same files once more) |
| WP5 | Low cleanup | ~0.5 d | anytime; batch last |

End-to-end regression after each WP: `py_compile`/`node --check` over touched files,
REPL smoke (`/help`, `/scan --help`, trailing-flag case, Ctrl-C), indexer re-run vs
baseline `index.json` counts, one `/generate api-tests --no-execute` pass.

## 8. Out of scope

- Adding a shared crawler↔indexer schema/fixture test (recommended follow-up: one JSDoc
  typedef for bundle.json + a fixture test against a real bundle — would have caught all
  three WP3 shape bugs).
- Any behavior changes beyond the fixes listed (no refactors of working logic).
