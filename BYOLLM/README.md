# BYOLLM — the skill / LLM interface (Service 3)

The thin BYO-LLM router installed in the developer's editor. The **host model**
(VS Code Copilot / Claude Code) does all reasoning; this service just tells it
the workflow and shells the deterministic engines.

Packaged as: a **Claude Code plugin** / a VS Code Copilot instructions file —
installed in the editor, never copied into the user's repo.

## What lives here (after migration — see docs/spec-16)

| File | Role |
|---|---|
| `ctx.mjs` | thin CLI front door the host drives — crawl → `testo` (local), generate/execute → `web-app` REST API |
| `skill/SKILL.md` | the Claude Code `/ctx` skill |
| `skill/copilot-instructions.md` | the VS Code Copilot variant |

Migrating from: `byo-llm-poc/ctx.mjs`, `byo-llm-poc/SKILL.md`,
`.claude/skills/testo-context/SKILL.md`.

## The loop it drives

scan (→ `testo` crawler on the device) → classify click-intents (the host model
itself) → annotate → generate + execute (→ `web-app` API) → report. No API keys,
no internal LLM — the editor's model is the brain.

> Status: **skeleton** — code moves in spec-16 Phase P3.
