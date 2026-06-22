# Module 2 — Skill Memory (a learning feedback loop)

_Borrowed from: Acontext ("Agent Skills as a Memory Layer"). Target: **`feedback/` + `skill-register/` + `agentic-harness`**._

## Goal

Turn the dead `feedback/` arrow into a learning loop. After every test run, distill *what happened and how it turned out* — failures, healed steps, recurring flakes, environment quirks — into **reusable Markdown skill files**. On the next run, agents (generation, healing, free-agent) pull the relevant ones back into context by **tool call**, not embedding similarity. Files are git-tracked, diffable, and portable — matching the project's "review QA like code" instinct.

This is the I_AGENT "memory" box on the architecture diagram, which is currently unimplemented.

## Current state (verified)

- `feedback/results-to-kb.mjs` **does not exist** — only `feedback/README.md`. There is **no `knowledge.json` on disk**, and `knowledge-base/build.mjs`/`store.mjs` don't exist either. So there is nothing to append to yet; the memory store must be self-contained.
- The real machine-readable run output today is the **`api-test-generator`'s `results.json`**: `output/generation/api-tests/results.json` and `output/generation/openapi-tests/results.json`, plus per-call artifacts `runs/<api_id>.json`. Record shape (`TestResult`): `{ opId|api_id, method, url, expected, actual, pass, ms, request{headers,body}, response{status,contentType,headers,body}, err }`.
- Playwright UI specs emit **no JSON** — the generated `playwright.config.mjs` uses `reporter: [['list'], ['html', …]]` only; `scripts/crawler/test-results/.last-run.json` is just `{status, failedTests}`. Adding a `json` reporter is a one-line change in `generator.mjs`.
- `skill-register` is a clean plug-in system: `REGISTERED_SKILLS: dict[str, SkillDefinition]` where `SkillDefinition = {name, source_path, skill_class, args_class, summary, layer}`; `SkillService.invoke_direct(skill, args) -> SkillInvocationResult{ok, mode, status, output, metadata}`; skills are dynamically imported from `source_path`. CLI: `bin/call_skill.py <name> --mode direct --<arg> <val>`. Template skill: `generation-layer/api-test-generator/skill.py` (pydantic args → `async execute(args) -> Result`).
- `agentic-harness` exposes the LLM-tool seam: `REGISTERED_TOOLS: dict[str, ToolDefinition]` (add a row → auto-discovered), tools are `openharness.tools.base.BaseTool` subclasses with `name`, `description`, `input_model`, `async execute(self, arguments, context) -> ToolResult{output, is_error, metadata}`. `testo ask` already runs a free-agent (`bin/ask.py`). Backend resolution (`MINIMAX → OPENAI → KIMI → OLLAMA`) lives in `agentic_harness/backends/catalog.py:BackendResolver`.
- `knowledge-sources/tribal-knowledge/` **does not exist** (only `knowledge-sources/README.md`); its planned tier is `docs_extracted` (0.55).
- The Python venv (`scripts/graphify/.venv`) has `openai` + `anthropic` available for the distillation LLM call.

## Architecture

```
            ┌─────────── STORE (write path) ───────────┐
run finishes → results.json (+ runs/*.json + heal-events.json from Module 3)
            → skill-distiller (LLM, single-shot)
            → route: update existing skill | create new
            → memory/skills/<id>.md  (+ memory/index.json)

            ┌─────────── RECALL (read path) ───────────┐
agent needs context → get_skill(scope,target,tags,query) → matching summaries
                    → get_skill_file(id) → full markdown   [tool-based, no embeddings]
generation/healing  → memory/select.py(target,page) → concatenated active skills → prepended to prompt
```

Three pieces: a **distiller skill** (write), two **recall tools** + a **deterministic selector** (read), and a **consolidation skill** (curate). All Markdown, all git-tracked.

## Memory store format

`memory/skills/<id>.md` — one file per learning, Acontext-style (you own the schema in `memory/SKILL.md`):

```markdown
---
id: superalign-login-spa-redirect
scope: app                 # global | app | page | endpoint | suite
target: auth.superalign.ai
tags: [login, redirect, spa]
kind: workaround           # workaround | gotcha | preference | sop | flake
status: active             # active | candidate | superseded
confidence: 0.80
hits: 3                    # times retrieved/applied
runs: [run-2026-06-04T09-12Z]
created: 2026-06-04T09:12:00Z
updated: 2026-06-05T07:40:00Z
---
## Symptom
Section specs for `/insights` fail intermittently: assertion `toHaveURL` runs before the SPA finishes `router.push`.

## Root cause
Client-side redirect after login isn't caught by `waitForLoadState('networkidle')`.

## Fix / workaround
After `login(page)`, call the crawler's `waitForUrlStable(page)` before asserting URL/title.

## Applies to
- pages: [page:https://console-preview.superalign.ai/insights, …]
- endpoints: []

## Evidence
- run-2026-06-04: 3/5 section specs flaked here; adding the wait → 5/5 green.
```

`memory/index.json` (fast filter; retrieval stays grep/tool-based per Acontext):

```json
{ "version": 1, "updated": "ISO", "skills": [
  { "id": "superalign-login-spa-redirect", "scope": "app", "target": "auth.superalign.ai",
    "tags": ["login","redirect","spa"], "kind": "workaround", "status": "active",
    "confidence": 0.8, "hits": 3, "path": "memory/skills/superalign-login-spa-redirect.md" }
] }
```

`memory/SKILL.md` documents the frontmatter schema, the `id` naming convention (`<target-slug>-<short-topic>`), and routing rules — the human-and-agent-readable contract.

## New files (file-by-file plan)

| Path | Lang | Role |
|---|---|---|
| `memory/SKILL.md` | md | Schema + naming + routing contract (the design doc agents read) |
| `memory/skills/.gitkeep` | — | Skill files live here |
| `memory/index.json` | json | Lightweight filter index |
| `feedback/skill-distiller/skill.py` | py | The distiller skill (`SkillDistillerSkill` / `SkillDistillerArgs`) |
| `feedback/skill-distiller/lib/trace.py` | py | Build a compact run-trace (failures, heals, flakes) from `results.json` + `runs/*.json` |
| `feedback/skill-distiller/lib/route.py` | py | Match candidate → existing skill (merge) or new (create); rebuild `index.json` |
| `feedback/skill-distiller/lib/llm.py` | py | Single-shot completion via `BackendResolver` (reuse project backend chain) |
| `infrastructure/agentic-harness/tools/get_skill.py` | py | `GetSkillTool` / `GetSkillArgs` — filtered list of skill summaries |
| `infrastructure/agentic-harness/tools/get_skill_file.py` | py | `GetSkillFileTool` / `GetSkillFileArgs` — full markdown by id |
| `memory/select.py` | py | Deterministic selector: `(target, page?, endpoint?) → concatenated active skills` |
| `feedback/consolidate/skill.py` | py | Consolidation skill: merge dupes, supersede stale, prune index |
| `feedback/results-to-kb.mjs` | node | (Optional) compact `testRuns[]` writer once a `knowledge.json` exists |

**Edited files:**

| Path | Change |
|---|---|
| `infrastructure/skill-register/skill_register/registry/skill_registry.py` | Register `skill-distiller` and `consolidate-memory` in `REGISTERED_SKILLS` |
| `infrastructure/agentic-harness/agentic_harness/registry/tool_registry.py` | Register `get_skill`, `get_skill_file` in `REGISTERED_TOOLS` |
| `scripts/crawler/generator/generator.mjs` | Add `['json', { outputFile: '…/output/generation/ui-tests/results.json' }]` to the `reporter` array so UI runs are distillable |
| `interfaces/cli/testo.mjs` + `interfaces/cli/commands/learn.mjs` | New `testo learn` command; optionally auto-invoke after `testo generate` |

## Code sketches

Distiller skill (mirrors `api-test-generator` exactly):

```python
# feedback/skill-distiller/skill.py
class SkillDistillerArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    results_path: Path = Path("output/generation/api-tests/results.json")
    heal_events:  Optional[Path] = None            # from Module 3, if present
    target:       str                              # e.g. "auth.superalign.ai"
    memory_dir:   Path = Path("memory")
    run_id:       Optional[str] = None
    min_confidence: float = 0.55

class SkillDistillerResult(BaseModel):
    ok: bool; created: int; updated: int; skipped: int
    files: list[str]; error: Optional[str] = None

class SkillDistillerSkill:
    name = "skill-distiller"
    async def execute(self, args: SkillDistillerArgs) -> SkillDistillerResult:
        return await asyncio.to_thread(self._run, args)

    def _run(self, args):
        trace = build_trace(args.results_path, args.heal_events)   # failures, heals, flakes only
        if not trace.has_signal: return SkillDistillerResult(ok=True, created=0, updated=0, skipped=0, files=[])
        candidates = distill_llm(trace, target=args.target)        # → [{title, scope, tags, kind, body, confidence}]
        created, updated, files = route_and_write(candidates, args.memory_dir, run_id=args.run_id)
        rebuild_index(args.memory_dir)
        return SkillDistillerResult(ok=True, created=created, updated=updated, skipped=0, files=files)
```

LLM call reusing the project backend chain (no dependency on the Node connector):

```python
# feedback/skill-distiller/lib/llm.py
def distill_llm(trace, target):
    cfg = resolve_backend()           # reuse agentic_harness BackendResolver; else env-based fallback
    client = OpenAI(base_url=cfg.base_url, api_key=os.environ.get(cfg.api_key_env, "ollama"))
    msg = PROMPT.format(target=target, trace=trace.to_compact_json())   # asks for STRICT JSON array
    out = client.chat.completions.create(model=cfg.model, temperature=0.2,
                                         response_format={"type": "json_object"}, messages=[{"role":"user","content":msg}])
    return parse_candidates(out.choices[0].message.content)
```

Recall tool (openharness `BaseTool`, registered in `REGISTERED_TOOLS`):

```python
# infrastructure/agentic-harness/tools/get_skill.py
class GetSkillArgs(BaseModel):
    target: Optional[str] = None
    scope:  Optional[str] = None
    tags:   list[str] = Field(default_factory=list)
    query:  Optional[str] = None        # substring/keyword over title+body
    limit:  int = 5

class GetSkillTool(BaseTool):
    name = "get_skill"
    description = "Retrieve learned QA skills (workarounds, gotchas, SOPs) filtered by target/scope/tags/query. Returns summaries; call get_skill_file for full content."
    input_model = GetSkillArgs
    async def execute(self, arguments, context) -> ToolResult:
        idx = json.loads(Path("memory/index.json").read_text())["skills"]
        hits = filter_skills(idx, arguments)                # status==active, match filters, rank by confidence*recency
        bump_hits([h["id"] for h in hits])
        return ToolResult(output=json.dumps(hits[:arguments.limit]), is_error=False, metadata={"count": len(hits)})
```

`memory/select.py` (deterministic injection, used by generation/healing before any LLM step):

```python
def select(target, page=None, endpoint=None, max_chars=6000) -> str:
    rows = [s for s in load_index() if s["status"] == "active" and matches(s, target, page, endpoint)]
    rows.sort(key=lambda s: (s["confidence"], s["updated"]), reverse=True)
    return "\n\n---\n\n".join(read_md(s["path"]) for s in rows)[:max_chars]
```

## Integration points

- **Write trigger** — `testo learn` runs the distiller on the latest `results.json`; optionally `commands/generate.mjs` auto-invokes it after a generate/run completes (one extra `call_skill.py skill-distiller` spawn). Heal events from Module 3 (`output/execution/heal-events.json`) feed the same distiller — **a healed step is a memory write**, so the two modules share one store.
- **Read injection** — `memory/select.py` output is prepended to: (a) the healing agent's prompt (Module 3), (b) the future LLM body-synthesis in `api-test-generator` (the `request_synth.py` hook noted in recon), (c) any `testo ask` free-agent run via the `get_skill` tool.
- **Confidence lifecycle** — new skill starts at the distiller's reported confidence (≥`min_confidence`); +0.1 (cap 0.95) each run that confirms it; flag `candidate`→`active` after 2 confirmations; mark `superseded` when a newer skill with the same `id`-stem contradicts it (consolidation decides).
- **Secret hygiene** — reuse the `api-test-generator` redaction (`Authorization: Bearer <redacted>`) before any trace text reaches the LLM or a markdown file. Add a regex scrub for emails/tokens in `lib/trace.py`.
- **KB feedback (optional/later)** — once `knowledge.json` exists, `results-to-kb.mjs` appends a compact `testRuns[]`; and Module 1's `text-kg` extractor can ingest `memory/skills/*.md` so durable learnings also become low-tier KB facts (`docs_extracted`). Not required for the loop to work.

## Build vs borrow

Borrow the **pattern**, not the **product**. Acontext's backend is PostgreSQL + S3 + Redis + RabbitMQ — overkill for a single-team harness. The write/route/recall loop above is ~200–300 LOC against systems you already have (`skill-register`, `agentic-harness`, `BackendResolver`). Acontext is Apache-2.0, so you *may* vendor specific pieces (e.g. its distillation prompt structure) — but the durable, lock-in-free idea is simply **plain Markdown skills in git, retrieved by tool**. Keep that and you can adopt the real product later without migrating data.

## Acceptance tests

1. Given a `results.json` with ≥2 failures, `skill-distiller` writes ≥1 `memory/skills/<id>.md` with complete frontmatter + the four body sections, and updates `index.json`.
2. **Idempotent routing** — re-running the distiller on the same `results.json` creates 0 new files; it bumps `hits`/`updated`/`runs` on the existing skill.
3. `get_skill(target="auth.superalign.ai")` returns the new skill; `get_skill_file(id=…)` returns the full markdown; both bump `hits`.
4. A `testo ask` free-agent run with `get_skill` registered retrieves and references a learned workaround in its answer.
5. `memory/select.py(target=…)` returns active skills sorted by confidence, truncated to `max_chars`, with no secrets present.
6. `consolidate-memory` merges two near-duplicate skills into one and marks the weaker `superseded`; `index.json` shrinks accordingly.
7. All skill files are valid Markdown with parseable YAML frontmatter and produce clean `git diff`s.

## Phasing

- **P0** — store format + `memory/SKILL.md`; `skill-distiller` (read `results.json` → markdown); register skill; `testo learn`. (Loop closes for API tests. ~3–4 days.)
- **P1** — `get_skill`/`get_skill_file` tools + `memory/select.py` injection into generation. Add JSON reporter to Playwright specs so UI runs distill too.
- **P1** — `consolidate-memory` skill; schedule it (the harness already has a scheduling capability) to run weekly.
- **P2** — optional KB feedback (`results-to-kb.mjs`, text-kg ingestion of memory).

## Risks / watch-outs

- **Garbage in, garbage out** — a weak distiller LLM will write noisy skills. Gate on `min_confidence`, keep new skills as `candidate` until confirmed, and require the strict-JSON `response_format` so parsing never silently fails (echo the agentic-harness "fail if no real output" honesty rule).
- **Store bloat** — without consolidation the store grows unbounded; ship `consolidate-memory` in P1, not "later."
- **Backend import** — if `agentic_harness.backends` isn't importable from the skill's venv, fall back to a 10-line env-based resolver (`MINIMAX_API_KEY` → … → `ollama`) so the distiller never hard-fails on import.
- **Don't double-build memory** — Module 3's "execution memory" is this store. One memory, two writers (distiller + heal events), many readers.
