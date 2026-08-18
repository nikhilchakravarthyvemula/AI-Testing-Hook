#!/usr/bin/env bash
#
# run-pipeline.sh — run the testing-harness pipeline end to end.
#
#   context layer → (optional) test generation+execution → (optional) report
#
# CONFIG COMES FROM .env ONLY. This script hardcodes no pipeline values; it
# loads .env, exports every key, and every stage (node/npm/python/playwright)
# inherits it. Edit .env to change behaviour — not this file.
#
# Usage:
#   ./run-pipeline.sh              # run per .env stage toggles
#   ./run-pipeline.sh --setup      # one-time: venv + crawler deps + clone codebase
#   ./run-pipeline.sh --context-only
#   ./run-pipeline.sh --with-generation --with-report
#   ./run-pipeline.sh --dry-run    # print the plan, run nothing
#   ./run-pipeline.sh --help
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
CODEBASE_CACHE="$REPO_ROOT/output/target-codebase"

# ── pretty logging ───────────────────────────────────────────────────────────
if [[ -t 1 ]]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; X=$'\033[0m'; else B= G= Y= R= C= X=; fi
log()  { printf '%s[pipeline]%s %s\n' "$C" "$X" "$*"; }
ok()   { printf '%s[pipeline] ✓%s %s\n' "$G" "$X" "$*"; }
warn() { printf '%s[pipeline] ⚠%s  %s\n' "$Y" "$X" "$*" >&2; }
err()  { printf '%s[pipeline] ✗%s %s\n' "$R" "$X" "$*" >&2; }
hr()   { printf '%s────────────────────────────────────────────────────────%s\n' "$B" "$X"; }

# ── flags ────────────────────────────────────────────────────────────────────
DO_SETUP=0; DRY_RUN=0; FORCE_CONTEXT_ONLY=0; FORCE_GEN=""; FORCE_REPORT=""
for arg in "$@"; do
  case "$arg" in
    --setup)            DO_SETUP=1 ;;
    --dry-run)          DRY_RUN=1 ;;
    --context-only)     FORCE_CONTEXT_ONLY=1 ;;
    --with-generation)  FORCE_GEN=1 ;;
    --with-report)      FORCE_REPORT=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) err "unknown flag: $arg (try --help)"; exit 2 ;;
  esac
done

# ── 1. load .env as the single source of truth (.env wins over the shell) ─────
load_env() {
  [[ -f "$ENV_FILE" ]] || { err ".env not found at $ENV_FILE"; exit 1; }
  local raw line key val n=0
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    line="${raw#"${raw%%[![:space:]]*}"}"                 # left-trim
    [[ -z "$line" || "$line" == \#* ]] && continue        # blank / comment
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
    if   [[ "$val" =~ ^\"(.*)\"$ ]]; then val="${BASH_REMATCH[1]}"   # "quoted"
    elif [[ "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"   # 'quoted'
    fi
    export "$key=$val"; n=$((n+1))
  done < "$ENV_FILE"
  ok "loaded $n vars from $(basename "$ENV_FILE")"
}
load_env

# stage toggles + defaults (all overridable from .env)
: "${RUN_CONTEXT:=1}" "${RUN_GENERATION:=0}" "${RUN_REPORT:=0}"
: "${STOP_ON_ERROR:=1}" "${SCENARIO:=scenario.json}"
[[ "$FORCE_CONTEXT_ONLY" == 1 ]] && { RUN_GENERATION=0; RUN_REPORT=0; }
[[ -n "$FORCE_GEN" ]]    && RUN_GENERATION="$FORCE_GEN"
[[ -n "$FORCE_REPORT" ]] && RUN_REPORT="$FORCE_REPORT"

# ── 2. derive effective config + validate ────────────────────────────────────
# Nothing to crawl → skip the crawler (else it hits BASE_URL's default and fails).
if [[ -z "${BASE_URL:-}" ]]; then
  case ",${SKIP:-}," in *,crawler,*) : ;; *) SKIP="${SKIP:+$SKIP,}crawler"; export SKIP ;; esac
  warn "BASE_URL is empty → added 'crawler' to SKIP (live crawl disabled)"
fi

# TARGET_CODEBASE must be a LOCAL directory. Handle a URL by (setup) cloning it,
# or (normal run) reusing a prior clone, else skip code extraction cleanly.
prepare_codebase() {
  local t="${TARGET_CODEBASE:-}"
  [[ -z "$t" ]] && return 0
  [[ -d "$t" ]] && { log "TARGET_CODEBASE → $t (local)"; return 0; }
  if [[ "$t" =~ ^(https?://|git@|ssh://) ]]; then
    if [[ -d "$CODEBASE_CACHE/.git" ]]; then
      export TARGET_CODEBASE="$CODEBASE_CACHE"; log "reusing cloned codebase → $CODEBASE_CACHE"; return 0
    fi
    if [[ "$DO_SETUP" == 1 ]]; then
      log "cloning $t → $CODEBASE_CACHE (shallow)…"; rm -rf "$CODEBASE_CACHE"
      if git clone --depth 1 "$t" "$CODEBASE_CACHE"; then export TARGET_CODEBASE="$CODEBASE_CACHE"; ok "cloned codebase"; return 0; fi
      warn "clone failed — code extractors will be skipped this run"
    else
      warn "TARGET_CODEBASE is a URL. Run './run-pipeline.sh --setup' to shallow-clone it, or point it at a local path."
    fi
  else
    warn "TARGET_CODEBASE '$t' is not a directory — code extractors will be skipped this run"
  fi
  unset TARGET_CODEBASE
}

# ── 3. optional one-time setup ───────────────────────────────────────────────
if [[ "$DO_SETUP" == 1 ]]; then
  hr; log "setup: prerequisites"; hr
  VENV="context-layer/content-extractor/_lib/.venv"
  if [[ -x "$VENV/bin/python" ]]; then ok "python venv present"; else
    log "creating python venv for code extractors…"
    python3 -m venv "$VENV" && "$VENV/bin/pip" install -q -r context-layer/content-extractor/_lib/requirements.txt \
      && ok "venv ready" || warn "venv setup failed — code extractors may not run"
  fi
  if [[ -n "${BASE_URL:-}" ]]; then
    # Root npm install covers the crawler too (testo/src/crawler is a workspace).
    if [[ -x node_modules/.bin/playwright ]]; then ok "crawler deps present"; else
      log "installing node deps (Playwright + Crawlee via workspaces)…"
      npm install && npx playwright install chromium \
        && ok "crawler ready" || warn "crawler setup failed — live crawl may not run"
    fi
  fi
  prepare_codebase
  hr; ok "setup complete — re-run without --setup to run the pipeline"; hr
  exit 0
fi

prepare_codebase

# ── banner ───────────────────────────────────────────────────────────────────
hr
log "${B}testing-harness pipeline${X}"
log "target url    ${BASE_URL:-<none>}"
log "codebase      ${TARGET_CODEBASE:-<none>}"
log "skip          ${SKIP:-<none>}    parallel=${PARALLEL:-1}  llm(crawler)=${CRAWLER_LLM:-0}"
log "stages        context=${RUN_CONTEXT} generation=${RUN_GENERATION} report=${RUN_REPORT}   stop_on_error=${STOP_ON_ERROR}"
[[ "$DRY_RUN" == 1 ]] && warn "dry-run: no stage will actually execute"
hr

# ── stage runner ─────────────────────────────────────────────────────────────
run_stage() {  # <name> <critical:0|1> <cmd...>
  local name="$1" critical="$2"; shift 2
  hr; log "▶ ${B}${name}${X}"; hr
  if [[ "$DRY_RUN" == 1 ]]; then log "(dry-run) $*"; return 0; fi
  if "$@"; then ok "${name} complete"; return 0; fi
  local code=$?
  if [[ "$critical" == 1 && "$STOP_ON_ERROR" == 1 ]]; then
    err "${name} failed (exit ${code}) — aborting pipeline"; exit "$code"
  fi
  warn "${name} failed (exit ${code}) — continuing"; return "$code"
}

# ── 4. run the pipeline ──────────────────────────────────────────────────────
[[ "$RUN_CONTEXT" == 1 ]] && run_stage "Context layer (extract → index → synthesize → gaps → features)" 1 \
  node context-layer/scan.mjs

if [[ "$RUN_GENERATION" == 1 ]]; then
  # UI generation+execution consolidated onto the ctx path (the same generator
  # the skill flow uses — testo e2e.mjs + Playwright). The scenario.json-driven
  # ui-test-generator was retired as a duplicate (SDD §3.4 "Duplication").
  run_stage "Test generation (API curls + UI specs)" 0 node byo-llm-poc/ctx.mjs generate --json
  run_stage "Test execution (API + UI)"              0 node byo-llm-poc/ctx.mjs execute --json
  if [[ -f "$SCENARIO" ]]; then
    run_stage "Perf test generation + run" 0 node generation-layer/perf-test-generator/gen.mjs "$SCENARIO"
  fi
fi

[[ "$RUN_REPORT" == 1 ]] && run_stage "Report build (Allure)" 0 \
  node generation-layer/allure-reporter/build.mjs

# ── 5. summary ───────────────────────────────────────────────────────────────
hr; log "${B}outputs${X}"; hr
if [[ "$DRY_RUN" != 1 ]]; then
  node -e '
    const fs=require("fs");
    const show=(label,p,fn)=>{ try{ const e=JSON.parse(fs.readFileSync(p,"utf8")); console.log("  "+label.padEnd(26), fn(e)); }catch{ console.log("  "+label.padEnd(26),"(not produced)"); } };
    show("facts (synthesizer)","output/synthesized/facts.json", e=>`${e.facts.length} facts, ${e.stats?.conflicts??0} conflicts`);
    show("gaps (gap-analyzer)","output/gaps/gaps.json", e=>`${e.stats?.totalGaps??e.gaps.length} gaps ${JSON.stringify(e.stats?.byType??{})}`);
    show("features (extractor)","output/features/features.json", e=>`${e.stats?.featureCount??0} features, ${e.stats?.unassignedFacts??0} unassigned`);
  ' 2>/dev/null || warn "no context-layer outputs found"
fi
hr; ok "pipeline finished"
