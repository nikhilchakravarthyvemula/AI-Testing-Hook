# C# ASP.NET

Wraps `CSharpAspNetExtractor` from `_lib/testing_agent/context_layer/sources/codebase/extractors/backend/csharp_aspnet.py`.

- **Source id:** `csharp-aspnet`
- **Output:** `output/sources/csharp-aspnet.json`
- **Tier:** inherited from the bundled extractor's `discovery_tier` (see `schema.mjs`)

## Run

```bash
TARGET_CODEBASE=/abs/path/to/repo \
  ../_lib/.venv/bin/python extract.py
```

Or use the meta-orchestrator from the repo root:

```bash
npm run extract -- ONLY=csharp-aspnet
```
