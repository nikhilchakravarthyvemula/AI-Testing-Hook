# Spec 13 — Remove the internal harness: pure MCP + skill (BYO-LLM), then monorepo-push

Status: **implemented** (2026-07-22, together with spec-14; amendments marked inline)
Depends on: spec-12 (BYO-LLM CLI + skill), the productionized MCP server (`AI-Hook-MCP-Server`, branch `mcp-poc` — absorbed into this monorepo as `mcp-server/`)

## Context

The BYO-LLM inversion is built and verified: the MCP server (tools `scan` / `generate` /
`execute` / `context`) and the Claude Code skill (`/ctx` over `byo-llm-poc/ctx.mjs`) drive the
deterministic pipeline while the HOST model (VS Code Copilot / Claude Code) does all reasoning
via MCP sampling. That makes the internal LLM orchestration layer — `testo/harness/`
(`agentic_harness`, openharness-ai wrapper, its own MiniMax backend resolver) and the
interactive REPL built on it — redundant.

Question answered: *"if we are going with mcp and skill approach we don't need the harness
right, we can remove it?"* → **Yes.** Exhaustive dependency mapping confirms the deterministic
pipeline (crawl → extract → index → generate → execute → report) has **zero** hard dependency
on the harness; only the REPL, the graphify extractor invocation, and two gated LLM passes
(framework-detector, db-schema) touch it.

End state also fulfils the standing request: push the **total codebase as one monorepo** to
`github.com/nikhilchakravarthyvemula/AI-Hook-MCP-Server`.

## Decisions (final)

| Fork | Decision |
|---|---|
| REPL | **Remove** — delete `repl.py`, `bootstrap.py`, `render.py`, `tools_list.py`, `testo` launcher + npm scripts. MCP + `/ctx` are the only surfaces. |
| Graphify extractor | **Rewire direct** — `graphify/extract.mjs` calls the graphify pip package straight from `_lib/.venv`, deterministic passes only (LLM-semantic pass off until Python host-routing exists). |
| MiniMax | **Delete entirely** — remove `providers/minimax.mjs`; `host` becomes the only + default provider; `MINIMAX_API_KEY` dead. |
| Repo shape | **Monorepo** — absorb the nested `AI-Hook-MCP-Server` repo into the main tree (as `mcp-server/`), push the whole cleaned codebase to the AI-Hook-MCP-Server remote as `main`. |

## Ground truth (dependency map)

**Real consumers of `testo/harness` (everything else is docstring/doc-only):**
1. `context-layer/content-extractor/graphify/extract.mjs:40,70,80` — subprocess → `call_tool.py graphify` → rewire direct
2. `context-layer/content-extractor/framework-detector/framework_extractor/llm_detector.py:52` — spawns `bin/ask.py`; fail-safe (`composite.py:_safe_llm_detect`), gated by `LLM_FRAMEWORK_DETECTION` → cut
3. `context-layer/content-extractor/code-extractors/db-schema/llm/extract.py:39` — also shells `ask.py` (opt-in `DBSCHEMA_LLM=1`, default off) → cut
4. `testo/repl.py:35-37`, `testo/tools_list.py:43-44`, `testo/bootstrap.py:19-22` → deleted with REPL
5. `package.json` `bin` block + scripts `testo` / `graphify` → removed

**Must stay (live in the new architecture):**
- `testo/skill-register/` — MCP `generate`/`execute` shell `bin/call_skill.py --json`; `api-test-generator/skill.py` implements `skill_register.ISkill`
- `testo/model-api-connector/` — crawler `llm-advisor` imports `getClient('host')` in the MCP `scan` path (only real importer)
- `testo/_lib/load-env.mjs` — used by perf/ui test generators + `chat.mjs`
- `context-layer/content-extractor/_lib/.venv` — the single Python runtime
- `agentic_harness` is NOT pip-installed anywhere (sys.path-only) — no venv surgery needed

**Key discoveries:**
- **Graphify is NOT in `_lib/.venv`** — pipx install (package `graphifyy` 0.7.15, binary `~/.local/bin/graphify`). Fix: `pip install graphifyy` into `_lib/.venv`, invoke `python -m graphify`. Core deps fully deterministic (networkx, tree-sitter, datasketch); `openai` only in un-installed extras.
- **`graphify update <path> --force` IS the whole deterministic pass** (AST extract + build + cluster + GRAPH_REPORT.md + graph.json + graph.html); only `graphify tree` is a second step. `GRAPHIFY_OUT` env (absolute) redirects output directly.
- **`requests` missing from requirements** (api-test-generator login flow; today only transitive via openharness) — must be added or the prune breaks fresh venv builds.
- **`rich` stays** (`_lib/testing_agent` platform logging). **`mcp` must be ADDED** (both MCP servers run on this venv).
- **Root `.vscode/mcp.json` already exists** (registers `testo-context`) — extend with `ai-hook`, don't replace.
- **Secret history scan pre-verified CLEAN**: no `.env`/`.docx`/hsbc file in any of the 3 commits; no `eyJ…`/`sk-…` tokens in any blob; `LOGIN_PASSWORD=` hits are placeholders only.
- `ai_hook_mcp/config.py::harness_root()` parent-walk works unchanged from `mcp-server/`.

## Implementation phases

### Phase 0 — Preserve the nested repo's uncommitted state (FIRST, mandatory)
`server.py` + `docs/ARCHITECTURE.md` are uncommitted in `AI-Hook-MCP-Server/`; `.git` removal is irreversible.
```bash
cd AI-Hook-MCP-Server
git add ai_hook_mcp/server.py docs/ARCHITECTURE.md
git commit -m "Final mcp-poc state: scan/generate/execute/context before monorepo absorption"
git push origin mcp-poc        # fallback if push fails: git bundle create <scratch>/ai-hook-mcp-poc.bundle --all
```

### Phase 1 — Delete harness, REPL, MiniMax
**Delete:** `testo/harness/` (whole tree) · `testo/{repl.py,bootstrap.py,render.py,tools_list.py,testo}` · `testo/model-api-connector/providers/minimax.mjs` · `code-extractors/db-schema/llm/` · `framework-detector/framework_extractor/{llm_detector.py,composite.py}`.
**Edit:**
- `package.json`: remove `bin` block (lines 7–9), `testo` script (line 11), `graphify` script (line 25).
- `testo/model-api-connector/index.mjs`: drop minimax import + PROVIDERS row; host only.
- `testo/model-api-connector/bin/chat.mjs`: default `'minimax'` → `'host'` (line 21) + header comment.
- `crawler/llm-advisor/index.mjs:59`: `|| 'minimax'` → `|| 'host'`; fix comments (lines 8–10, 48–55).
- Comment-only: `crawler/llm-advisor/strip-think.mjs:1–9` (keep module), `crawler/extract.mjs`, `byo-llm-poc/ctx.mjs:72` ("graphify is always-LLM" now false).

### Phase 2 — Graphify direct (deterministic)
Prereq: `_lib/.venv/bin/pip install graphifyy`; verify `python -m graphify --help`.
Rewrite `graphify/extract.mjs` lines 37–93 only (keep TARGET_CODEBASE guard, freshness guard, bundle contract — indexer reads `output/graphify/bundle.json` + `graph.json`):
```js
const PY = path.join(REPO_ROOT, 'context-layer', 'content-extractor', '_lib', '.venv', 'bin', 'python');
const GRAPHIFY_OUT = process.env.GRAPHIFY_OUT_DIR || path.join(REPO_ROOT, 'output', 'graphify');
// LLM-semantic pass intentionally disabled (no Python host-routing yet)
const env = { ...process.env, GRAPHIFY_OUT, GRAPHIFY_NO_TIPS: '1' };
const spawnOpts = { cwd: path.join(REPO_ROOT, 'output'), env, stdio: 'inherit' };   // cwd=output/ catches stray manifest.json
execFileSync(PY, ['-m', 'graphify', 'update', TARGET_CODEBASE, '--force'], spawnOpts);
execFileSync(PY, ['-m', 'graphify', 'tree', '--graph', path.join(GRAPHIFY_OUT, 'graph.json'),
  '--output', path.join(GRAPHIFY_OUT, 'GRAPH_TREE.html'), '--root', TARGET_CODEBASE], spawnOpts);
```
Drop the `AGENTIC_MODE` block (only extract.mjs references it). Keep the try/catch around both calls. ~~Both scan front doors keep `SKIP=graphify` (latency) — just fix the stale comments.~~ **Superseded by spec-14 (run_all):** both scan front doors LIFT `SKIP=graphify` — graphify runs whenever `TARGET_CODEBASE` is provided (run.mjs's gate covers url-only runs).

### Phase 3 — Framework-detector + db-schema LLM cut (full deletion)
- `framework_extractor/__init__.py`: drop composite/llm_detector imports + 4 `__all__` entries + docstring rows.
- `framework-detector/extract.py`: remove LLM imports (lines 39, 41), `_build_detector()` (72–88), `--llm` arg + `LLM_FRAMEWORK_DETECTION` read (59–69); use `DeterministicFrameworkDetector()` directly. Output shape safe (`run.mjs` reads only `recommendedExtractors`).
- `db-schema/extract.py`: remove `LLM_SCRIPT` (line 47) + `DBSCHEMA_LLM` branch (76–86 → `llm_bundle = None`); keep `_merge` (tolerates None); fix docstring.
- Remove dead `"LLM_FRAMEWORK_DETECTION": "never"` from MCP `server.py:111` and `ctx.mjs:71`.
- `framework-detector/README.md`: drop LLM sections.

### Phase 4 — `_lib/requirements.txt` final list
```
graphifyy            # deterministic knowledge-graph CLI (update/tree); LLM extras NOT installed
mcp>=1.0             # mcp-server/ai_hook_mcp + byo-llm-poc/mcp_server.py
pydantic>=2.7,<3     # skill_register, framework_extractor, code_extractors, testing_agent, api-test-generator
pyyaml>=6.0,<7       # testing_agent openapi_file extractor
requests>=2.31       # api-test-generator login flow (was transitive via openharness — now explicit)
rich>=14.2           # testing_agent platform logging
```
Removed: `openharness-ai`, `openai` (zero surviving importers — verified census). Optionally `pip uninstall openharness-ai openai` from the live venv.

### Phase 5 — Monorepo absorption
```bash
mkdir -p mcp-server
mv AI-Hook-MCP-Server/{ai_hook_mcp,pyproject.toml,docs,README.md} mcp-server/   # (mv individually)
rm -rf AI-Hook-MCP-Server/.git AI-Hook-MCP-Server/.vscode AI-Hook-MCP-Server/.gitignore mcp-server/ai_hook_mcp/__pycache__
rmdir AI-Hook-MCP-Server
```
Rewrite root `.vscode/mcp.json` — keep `testo-context`, ADD `ai-hook`:
`command` = `${workspaceFolder}/context-layer/content-extractor/_lib/.venv/bin/python`, `args` = `["-m","ai_hook_mcp.server"]`, `cwd` = `${workspaceFolder}/mcp-server`, env `AI_HOOK_ROOT` = `${workspaceFolder}`.

### Phase 6 — Docs (minimal)
- Root `README.md`: folder map (no harness/REPL; model-api-connector = host; add `mcp-server/`, `byo-llm-poc/` + skill) + "BYO-LLM: no API keys in this repo" paragraph.
- `testo/README.md`: replace with ~10-line stub (two survivors) → points at `mcp-server/docs/ARCHITECTURE.md`.
- `mcp-server/docs/ARCHITECTURE.md`: collapse two-repo split into monorepo; fix minimax mentions (fallback is now `host`; no bridge → advisor returns null → deterministic).
- `mcp-server/README.md`: un-scaffold status line; note monorepo home.
- `byo-llm-poc/README.md`, `graphify/README.md` (rewrite: direct `python -m graphify`), `model-api-connector/README.md` (host-only), `crawler/llm-advisor/README.md` (env table: `LLM_PROVIDER`/`SAMPLING_BRIDGE_URL`/`SAMPLING_TOKEN`).
- `docs/spec-*.md`: untouched except optional one-line "superseded" note atop spec-05/spec-07.

### Phase 7 — Secret-safety pre-push gate (re-run at push time)
```bash
git check-ignore -v .env "SDD - AI Testing Harness (HSBC) v1.0.docx"     # both must match
git log --all --name-only --pretty=format: | sort -u | grep -iE '\.env$|\.docx$|hsbc'   # expect empty
git grep -lE 'eyJ[A-Za-z0-9_-]{30,}|sk-[A-Za-z0-9]{20,}' $(git rev-list --all)          # expect empty
git status --porcelain | grep -iE '\.env|\.docx'                                        # expect empty
git diff --cached --name-only | grep -iE '\.env|\.docx'                                 # expect empty
```

### Phase 8 — Verification suite (pre-push)
1. MCP server from new home: `cd mcp-server && …/.venv/bin/python -c "…mcp.list_tools()…"` → `['context','execute','generate','scan','test_app']` (test_app added by spec-14)
2. generate E2E: `call_skill.py api-test-generator --mode direct --json --execute false` → `[call_skill:result]` with `curls_generated`
3. `node byo-llm-poc/ctx.mjs scan --reuse` → `ok: true` envelope
4. `TARGET_CODEBASE=<abs repo> npm run extract` → graphify bundle `ok:true, stale:false`, nonzero nodes; framework-detection `detectorName:"deterministic"`; no harness spawn in log
5. `node context-layer/indexer/index.mjs` → exit 0, graphify + framework topics present
6. Dead-ref grep (`agentic_harness|call_tool|ask\.py|minimax`, excl. node_modules/.venv/output/spec docs) → only intentional historical hits
7. Optional strongest: scratch rebuild of `_lib/.venv` from pruned requirements, rerun 1–2 (proves requests/mcp additions)

### Phase 9 — Commit + push (monorepo → AI-Hook-MCP-Server)
```bash
git checkout -b byo-llm-monorepo          # keep feature-cli-testo pristine
git add -A                                 # deletions + mcp-server/ + .vscode/ + .claude/skills/ + byo-llm-poc/ + host.mjs
# re-run Phase 7 checks
git commit -m "BYO-LLM migration: delete internal harness/REPL/MiniMax; graphify direct-deterministic; absorb MCP server as mcp-server/"
git remote add mcp git@github.com:nikhilchakravarthyvemula/AI-Hook-MCP-Server.git
git push mcp HEAD:refs/heads/main          # unrelated history to mcp-poc — expected
# optional backup: git push origin byo-llm-monorepo
```
Manual UI step (no gh CLI): GitHub → AI-Hook-MCP-Server → Settings → default branch → `main`. `mcp-poc` stays for history.

## Risks
- Phase 0 is mandatory-first (nested `.git` removal irreversible for uncommitted work).
- `pip install graphifyy` must precede verification 8.4; escape hatch `GRAPHIFY_BIN=~/.local/bin/graphify`.
- Repo visibility unknown → Phase 7 gate non-negotiable; push uploads all 3 AI-Testing-Hook commits (history verified clean).
- Stale `LLM_PROVIDER=minimax` in anyone's `.env` → advisor logs warning, returns null (deterministic fallback) — acceptable; note in commit message.
