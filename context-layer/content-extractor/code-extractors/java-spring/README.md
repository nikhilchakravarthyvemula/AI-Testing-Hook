# Java Spring

Wraps `JavaSpringExtractor` from `_lib/testing_agent/context_layer/sources/codebase/extractors/backend/java_spring.py`.

- **Source id:** `java-spring`
- **Output:** `output/sources/java-spring.json`
- **Tier:** inherited from the bundled extractor's `discovery_tier` (see `schema.mjs`)

## Run

```bash
TARGET_CODEBASE=/abs/path/to/repo \
  ../_lib/.venv/bin/python extract.py
```

Or use the meta-orchestrator from the repo root:

```bash
npm run extract -- ONLY=java-spring
```
