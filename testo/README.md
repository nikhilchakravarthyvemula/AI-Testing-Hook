# @superalign/testo — the device-local testing engine (Service 1)

The deterministic engine that turns a live web app into structured test context.
Packaged as an **npm package** (`@superalign/testo`), it runs on the developer's
device (Win/Mac/Linux) because the crawl needs *their* browser + SSO session.
No LLM here — the host editor's model (via the `BYOLLM` skill) does the
click-intent reasoning; the Python generate/execute lives in the `web-app` service.

## Use

```bash
testo scan  --url <URL> [--codebase <PATH>] [--reuse]   # crawl + index
testo crawl --url <URL>                                  # crawl only
testo index                                              # index existing output/
```

## Layout

```
testo/
├── bin/testo.mjs        the CLI (slim orchestrator: crawl → index)
├── src/
│   ├── crawler/         Playwright crawl — walker, wire-guard, login-once, deterministic advisor
│   └── indexer/         merge source bundles under output/ → topics
└── package.json         bin + files (src, bin)
```

Output lands in the consuming project's `output/` (the only writable surface).

## Migration status (spec-16)

- ✅ P1 — `crawler` + `indexer` moved here; `bin/testo.mjs` + `package.json` added.
- ⏳ Still parked here pending **P2** (move to `web-app`): `skill-register/`, `_lib/`
  — these are the Python skill runtime and shared lib, which belong to the
  containerized service, not the device engine.

See `docs/spec-16-three-service-rollout.md`.
