# Java JAX-RS

Wraps `JavaJaxRsExtractor` from `_lib/testing_agent/context_layer/sources/codebase/extractors/backend/java_jaxrs.py`.

- **Source id:** `java-jaxrs`
- **Output:** `output/sources/java-jaxrs.json`
- **Tier:** inherited from the bundled extractor's `discovery_tier` (see `schema.mjs`)

## Run

```bash
TARGET_CODEBASE=/abs/path/to/repo \
  ../_lib/.venv/bin/python extract.py
```

Or use the meta-orchestrator from the repo root:

```bash
npm run extract -- ONLY=java-jaxrs
```
