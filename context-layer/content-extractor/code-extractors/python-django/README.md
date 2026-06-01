# Python Django

Wraps `PythonDjangoExtractor` from `_lib/testing_agent/context_layer/sources/codebase/extractors/backend/python_django.py`.

- **Source id:** `python-django`
- **Output:** `output/sources/python-django.json`
- **Tier:** inherited from the bundled extractor's `discovery_tier` (see `schema.mjs`)

## Run

```bash
TARGET_CODEBASE=/abs/path/to/repo \
  ../_lib/.venv/bin/python extract.py
```

Or use the meta-orchestrator from the repo root:

```bash
npm run extract -- ONLY=python-django
```
