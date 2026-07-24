# web-app — containerized pipeline service (Service 2)

The deterministic, Python-heavy, compute-heavy side of testo, deployed as a
**Docker image** to a VM / container. This is where immutability is strongest —
the engine is a **read-only image layer**, so no one (including an LLM) can edit
it in production.

Exposes a **plain REST API** (not MCP — the client org blocks MCP chat; see
spec-15 Phase A). The `BYOLLM` skill calls it over HTTP; devices upload crawl
bundles to it.

## What lives here (after migration — see docs/spec-16)

| Dir | Role |
|---|---|
| `api/` | REST server — submit a crawl bundle → generate/execute → return results |
| `skills/api-test-generator/` | build + run curl API tests (deterministic) |
| `skills/skill-register/` | the skill runtime (`call_skill.py`) |
| `extractors/` | framework-detector, code-extractors, graphify, mock-data, openapi-probe, db-schema |
| `reporters/` | allure + pdf report builders |
| `dashboard/` | results UI (graph-viewer, mind-map) |
| `_lib/` | shared `testing_agent` |
| `Dockerfile`, `pyproject.toml` | declared deps (retires the hand-built `_lib/.venv`) |

Migrating from: `generation-layer/**` (Python), `testo/skill-register/`,
`context-layer/content-extractor/{framework-detector,code-extractors,graphify,mock-data,openapi-probe}/`,
`context-layer/{graph-viewer,mind-map-builder}/`.

## Runs

- **Headless CI crawls** — against a staging env with a service account (no display → no interactive MFA).
- **The deterministic pipeline** for device-originated crawl bundles.
- **The shared dashboard** for maps / reports / coverage.

> Status: **skeleton** — code moves in spec-16 Phase P2.
