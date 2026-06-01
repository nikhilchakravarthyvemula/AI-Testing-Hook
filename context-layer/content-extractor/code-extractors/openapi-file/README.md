# OpenAPI file

Wraps `OpenAPIFileExtractor` from `_lib/testing_agent/context_layer/sources/codebase/extractors/specs/openapi_file.py`.

- **Source id:** `openapi-file`
- **Output:** `output/sources/openapi-file.json`
- **Tier:** inherited from the bundled extractor's `discovery_tier` (see `schema.mjs`)

## Run

```bash
TARGET_CODEBASE=/abs/path/to/repo \
  ../_lib/.venv/bin/python extract.py
```

Or use the meta-orchestrator from the repo root:

```bash
npm run extract -- ONLY=openapi-file
```
