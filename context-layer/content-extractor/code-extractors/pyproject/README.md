# pyproject.toml facts

Wraps `PyProjectFactsExtractor` from `_lib/testing_agent/context_layer/sources/codebase/extractors/facts/pyproject.py`.

- **Source id:** `pyproject`
- **Output:** `output/sources/pyproject.json`
- **Tier:** inherited from the bundled extractor's `discovery_tier` (see `schema.mjs`)

## Run

```bash
TARGET_CODEBASE=/abs/path/to/repo \
  ../_lib/.venv/bin/python extract.py
```

Or use the meta-orchestrator from the repo root:

```bash
npm run extract -- ONLY=pyproject
```
