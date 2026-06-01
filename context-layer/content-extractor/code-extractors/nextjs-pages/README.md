# Next.js Pages Router

Wraps `NextJSPagesExtractor` from `_lib/testing_agent/context_layer/sources/codebase/extractors/frontend/nextjs_pages.py`.

- **Source id:** `nextjs-pages`
- **Output:** `output/sources/nextjs-pages.json`
- **Tier:** inherited from the bundled extractor's `discovery_tier` (see `schema.mjs`)

## Run

```bash
TARGET_CODEBASE=/abs/path/to/repo \
  ../_lib/.venv/bin/python extract.py
```

Or use the meta-orchestrator from the repo root:

```bash
npm run extract -- ONLY=nextjs-pages
```
