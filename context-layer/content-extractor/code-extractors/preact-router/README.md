# Preact Router

Wraps `PreactRouterExtractor` from `_lib/testing_agent/context_layer/sources/codebase/extractors/frontend/preact_router.py`.

- **Source id:** `preact-router`
- **Output:** `output/sources/preact-router.json`
- **Tier:** inherited from the bundled extractor's `discovery_tier` (see `schema.mjs`)

## Run

```bash
TARGET_CODEBASE=/abs/path/to/repo \
  ../_lib/.venv/bin/python extract.py
```

Or use the meta-orchestrator from the repo root:

```bash
npm run extract -- ONLY=preact-router
```
