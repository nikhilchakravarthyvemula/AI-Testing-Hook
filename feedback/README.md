# Feedback

The "results inform the next run" arrow on the architecture diagram.

`results-to-feedback.mjs` — after `playwright test` finishes, parse the JSON
reporter output and append results under `output/execution/` (future: Postgres via the store-relational skill — docs/spec-10).
Next pipeline run sees what passed/failed last time.
