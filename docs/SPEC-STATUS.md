# Spec status — ground-truthed index

Verified against the working tree on 2026-08-19 (per-spec agent audit, not the specs' own
"Status:" headers — several of those are stale). Regenerate anytime with the `progress` skill.

**Roll-up: 14 specs — 1 done, 2 mostly-done, 2 partial, 9 doc-only. Mean built ≈ 24%.**

## Active — the specs that matter right now

| Spec | Title | Built | Where it stands |
|---|---|---|---|
| [15](spec-15-copilot-deferred-destructiveness.md) | Copilot-deferred destructiveness | **80%** | Phases A–D verifiably built (advisor stub, intent schema, mutation guard, blocked-flag fold-back). Missing: `explore-destructive` pass-2 + Phase E Copilot entry point. **Closest to done — finish first.** |
| [12](spec-12-byo-llm-cli-and-skill.md) | BYO-LLM CLI + skill | **70%** | Core inversion works (clean-JSON envelope, delegation, write-back). Missing: `enrich-graph`, enterprise/packaging layer — both now owned by spec-17. |
| [14](spec-14-run-all-narrated-pipeline.md) | run_all narrated pipeline | **45%** | Skill-surface half live. The MCP half was built then **deliberately deleted** (53e10b8 — org blocks MCP); needs a re-scope to mark the MCP half superseded rather than pending. |
| [16](spec-16-three-service-rollout.md) | Three-service rollout | **30%** | `testo/` package carved with CLI, old locations deleted. `web-app/` and `BYOLLM/` are README-only shells; upload contract has zero code. |
| [17](spec-17-knowledge-sources-and-context-layer.md) | Knowledge sources + context layer | **5%** | Plan-of-record for the pilot (written 2026-08-19). Only the pre-existing synthesizer scaffold + schema tiers exist. Six-week phasing inside. |

## Done

| Spec | Title | Built | Note |
|---|---|---|---|
| [13](spec-13-remove-harness-pure-byo-llm-monorepo.md) | Remove internal harness (pure BYO-LLM) | **95%** | Implemented in 884f202. The only unbuilt piece (MCP absorption) was removed deliberately by spec-15/16 — treat as complete. |

## Superseded / dead — do not build as written

| Spec | Title | Why dead |
|---|---|---|
| [05](spec-05-harness-as-tool-runtime.md) | Harness as tool runtime | Superseded by spec-13 — the harness it extends was removed. |
| [07](spec-07-interactive-harness-repl.md) | Interactive harness REPL | Same: substrate removed by spec-13. |
| [09](spec-09-tool-catalog-and-adapter.md) | Tool catalog + SubprocessStageTool | Deliverables deleted with the harness (884f202). |
| [06](spec-06-github-device-auth-llm.md) | GitHub device-flow → Copilot/Models LLM | Moot twice over: target dir removed, **and** the SDD constraint "the engine makes no model calls" rules out any engine-side model provider. |
| [08](spec-08-copilot-sdk-github-models.md) | Copilot SDK / GitHub Models provider | Same reason as 06 — org provides no model API; host-chat-only is the locked architecture. |

## Stale backlog — re-triage before touching

| Spec | Title | Built | What's needed first |
|---|---|---|---|
| [04](spec-04-crawl-action-recording.md) | Crawl action recording → replayable tests | 0% | Still wanted (generators still use has-text selectors + hardcoded fills), but every target path moved to `testo/src/` — remap file/line references before implementing. |
| [10](spec-10-output-storage-skills.md) | Output storage (Postgres/graph/bucket) | 0% | Pure design; now belongs to the SDD's hosted-service half. Fold into the web-app/spec-16 workstream rather than reviving standalone. |
| [11](spec-11-code-standards-remediation.md) | Code-standards remediation | 5% | Backlog never executed; ~half the flagged files were deleted, not fixed. Re-run the audit on the current tree before acting. |

## Architecture notes

| Doc | What it locks |
|---|---|
| [secrets-and-credentials-architecture.md](secrets-and-credentials-architecture.md) | Credential model: pilot = individual PAT + device keystore (built); target = dashboard holds config + secret *references*, values in Google Secret Manager, sync server-side, scanner ingests data only. Includes the SDD amendments the target state needs. |

## Component specs (docs/components/)

Fine-grained specs for individual context-layer components — moved here from
`context-layer/specs/` on 2026-08-19 so every spec lives under `docs/`. Unlike the spec-NN
series (cross-cutting architecture), these describe one component each and have real
implementations sitting next to them:

| Component spec | Implementation | Notes |
|---|---|---|
| [knowledge-synthesizer.spec.md](components/knowledge-synthesizer.spec.md) | `context-layer/knowledge-synthesizer/synthesize.mjs` | Component 2 — factId resolution + cross-family confidence fusion; deterministic with `SYNTH_LLM=0` |
| [gap-analyzer.spec.md](components/gap-analyzer.spec.md) | `context-layer/gap-analyzer/analyze.mjs` | Component 3 — shadow/untested/conflict/low-trust gaps, ranked |
| [feature-extractor.spec.md](components/feature-extractor.spec.md) | `context-layer/feature-extractor/extract.mjs` | Component 4 — deterministic feature clustering |
| [CONTEXT-LAYER-COMPONENTS.md](components/CONTEXT-LAYER-COMPONENTS.md) | — | Umbrella doc for the component series (root-level duplicate removed) |

Spec-17 builds on these three components; their per-component detail lives here, not in spec-17.

## Suggested reading order for a newcomer

13 (what was removed and why) → 12 (the architecture that replaced it) → 15 (safety model)
→ 16 (packaging/service split) → 17 (current pilot plan). Everything else is history or
pending re-triage.
