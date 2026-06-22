# test-script-generator

Generates runnable **Playwright UI test scripts** from the crawler's output
(routes / pages / click-graph). Re-homed here from `scripts/crawler/generator/`
(it's test generation — a generation-layer concern, not the crawler engine).

Reads `output/crawler/{data,…}` (resolved via repo root); writes Playwright
`.spec.mjs` + a `playwright.config.mjs` under `tests/`.

```bash
npm run generate     # node generator.mjs — page/route smoke specs
npm run e2e-gen      # node e2e.mjs — journey/E2E specs (crawler + graphify)
```

Complements the API-side generators in `../api-test-generator/` (Python) and
`../openapi-test-gen/` (JS, spec-driven).
