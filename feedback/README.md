# Feedback

The "results inform KB" arrow on the architecture diagram.

`results-to-kb.mjs` — after `playwright test` finishes, parse the JSON
reporter output and append results to `knowledge.json#facts.testRuns[]`.
Next pipeline run sees what passed/failed last time.
