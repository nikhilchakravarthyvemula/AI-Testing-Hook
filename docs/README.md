# Design specs — kg-gen, memory layer, agentic QA

Detailed, file-accurate design specs for borrowing from three reference projects, derived from a code-level recon of this repo (not just the READMEs). Read [`../IMPROVEMENT-ROADMAP.md`](../IMPROVEMENT-ROADMAP.md) first for the high-level rationale.

| Spec | Module | Reference | Target layer |
|---|---|---|---|
| [spec-01](spec-01-kg-graph-analytics.md) | Knowledge-graph analytics + text triples | kg-gen + NetworkX | Context Layer (`feature-extractor`, `gap-analyzer`, `mind-map-builder`, viewer) |
| [spec-02](spec-02-skill-memory.md) | Skill-memory learning loop | Acontext | `feedback/` + `skill-register` + `agentic-harness` |
| [spec-03](spec-03-agentic-execution.md) | Self-healing execution, cache, hooks | vostride/agent-qa | Execution Layer (greenfield) |

## How they interlock

The three are not independent — they form the feedback loop the architecture diagram draws but never implemented:

```
Module 1 (graph analytics) ── priority/features/gaps ──▶ Generation
                                                            │
                                                            ▼
Module 3 (self-healing execution) ── runs specs, observes reality
        │                                   │
        │ heal-events ─────────────┐        │ results.json
        ▼                          ▼        ▼
      action-cache (fast)    Module 2 (skill memory: distill → Markdown)
                                   │
                                   └── memory/select ──▶ feeds back into Generation + Healing
```

**One shared memory.** Module 2 owns the store; Module 1 (text-kg facts) and Module 3 (heal-events) are both *writers*. Do not build memory twice.

## Unified build order (critical path)

1. **M1 · P0a–b** — NetworkX analytics over `click-graph.json` → `feature-extractor` + `gap-analyzer` + viewer styling. *Lowest effort, no new deps, immediate value (risk-ranked test priority).*
2. **M2 · P0** — skill-memory store + `skill-distiller` over `api-test-generator`'s `results.json` + `testo learn`. *Closes the loop for API tests.*
3. **M3 · P0/P1** — license-check agent-qa (decision gate), then build the real Execution Layer (`test-executor` + json reporter + `testo run`/`report`).
4. **M2 · P1 + M3 · P2** — recall tools (`get_skill`) + self-healing (`heal.mjs`) + action cache; wire heal-events → memory → healer. *This is where the loop starts compounding.*
5. **M1 · P1** — `mind-map-builder` (GraphML/Mermaid) + `text-kg` (kg-gen) for tribal/Jira/Confluence.
6. **M3 · P3** — sandboxed hooks + `container-deploy`; optional NL test authoring.

## License gate (read before vendoring code)

- **NetworkX** — BSD. Safe to vendor (M1).
- **Acontext** — Apache-2.0. Safe to vendor; recommended to borrow the *pattern* only, not the PG/S3/Redis/RabbitMQ backend (M2).
- **kg-gen** — verify license before enabling the text extractor (M1, P1).
- **agent-qa** — tagged `fair-source`/`FSL`, **not** OSI open-source. **Read `LICENSE.md` before pulling any code into a commercial product** (M3, P0 decision gate).
