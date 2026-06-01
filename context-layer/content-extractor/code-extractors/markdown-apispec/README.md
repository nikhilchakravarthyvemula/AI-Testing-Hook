# Markdown API spec

Wraps `MarkdownAPISpecExtractor` from `_lib/testing_agent/context_layer/sources/codebase/extractors/specs/markdown_apispec.py`.

- **Source id:** `markdown-apispec`
- **Output:** `output/sources/markdown-apispec.json`
- **Tier:** inherited from the bundled extractor's `discovery_tier` (see `schema.mjs`)

## Run

```bash
TARGET_CODEBASE=/abs/path/to/repo \
  ../_lib/.venv/bin/python extract.py
```

Or use the meta-orchestrator from the repo root:

```bash
npm run extract -- ONLY=markdown-apispec
```
