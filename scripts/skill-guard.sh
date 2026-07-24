#!/usr/bin/env bash
# skill-guard.sh — make the harness + skill code READ-ONLY around a skill run.
#
# While the /ctx skill runs, the host LLM should only be able to READ the
# pipeline/skill code and the test app — never edit code or mutate the app.
# This toggles the code dirs read-only (chmod) so ANY write — the Edit/Write
# tool, a `bash` redirect, or a prompt-injected command — fails with EACCES.
# `output/` (the pipeline's only write target) stays writable.
#
#   ./scripts/skill-guard.sh lock      # BEFORE a /ctx run
#   ./scripts/skill-guard.sh unlock    # AFTER, to resume development
#   ./scripts/skill-guard.sh status
#
# Boundary strength: run by the SAME user, the agent could chmod back — this is
# a strong *tripwire*, not an unbreakable wall. For a boundary the agent CANNOT
# undo, either run `lock` under sudo after `chown -R root <dirs>`, or run the
# whole skill in a container with the code bind-mounted read-only (`:ro`) and
# only `output/` writable. The app's network writes are separately blocked by
# the crawler's wire-level mutation guard (INTERCEPT_MODE, see crawl.mjs).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Everything the LLM should only READ during a skill run.
CODE_DIRS=(
  context-layer testo generation-layer mcp-server byo-llm-poc
  execution-layer feedback docs scripts .claude/skills .vscode
)
# Loose top-level code/config files worth locking too.
CODE_FILES=(package.json package-lock.json .gitignore)
# The pipeline's only legitimate write target — stays writable.
WRITABLE=(output)

cmd="${1:-status}"
case "$cmd" in
  lock)
    for d in "${CODE_DIRS[@]}"; do [ -e "$ROOT/$d" ] && chmod -R a-w "$ROOT/$d"; done
    for f in "${CODE_FILES[@]}"; do [ -e "$ROOT/$f" ] && chmod a-w "$ROOT/$f"; done
    mkdir -p "$ROOT/output"
    for w in "${WRITABLE[@]}"; do [ -e "$ROOT/$w" ] && chmod -R u+w "$ROOT/$w"; done
    echo "🔒 read-only: ${CODE_DIRS[*]}"
    echo "✍️  writable : ${WRITABLE[*]}"
    echo "   (app network writes are blocked separately by the crawler wire-guard)"
    ;;
  unlock)
    for d in "${CODE_DIRS[@]}"; do [ -e "$ROOT/$d" ] && chmod -R u+w "$ROOT/$d"; done
    for f in "${CODE_FILES[@]}"; do [ -e "$ROOT/$f" ] && chmod u+w "$ROOT/$f"; done
    echo "🔓 writable: ${CODE_DIRS[*]}"
    ;;
  status)
    for d in "${CODE_DIRS[@]}"; do
      [ -e "$ROOT/$d" ] || continue
      f="$(find "$ROOT/$d" -type f -print -quit 2>/dev/null || true)"
      if [ -n "$f" ] && [ -w "$f" ]; then echo "🔓 $d (writable)"; else echo "🔒 $d (read-only)"; fi
    done
    ;;
  *)
    echo "usage: skill-guard.sh {lock|unlock|status}" >&2
    exit 2
    ;;
esac
