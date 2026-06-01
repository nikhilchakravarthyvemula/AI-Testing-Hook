# package.json facts

Wraps `PackageJSONFactsExtractor` from `_lib/testing_agent/context_layer/sources/codebase/extractors/facts/package_json.py`.

- **Source id:** `package-json`
- **Output:** `output/sources/package-json.json`
- **Tier:** inherited from the bundled extractor's `discovery_tier` (see `schema.mjs`)

## Run

```bash
TARGET_CODEBASE=/abs/path/to/repo \
  ../_lib/.venv/bin/python extract.py
```

Or use the meta-orchestrator from the repo root:

```bash
npm run extract -- ONLY=package-json
```
