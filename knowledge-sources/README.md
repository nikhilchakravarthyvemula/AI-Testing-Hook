# Knowledge Sources

Each sub-folder is a `Source` — it extracts facts from one kind of input and
emits a normalized JSON file in `output/sources/<source-name>.json` carrying
**provenance** (DiscoveryTier + confidence + extractedAt).

| Source | Input | Output | Confidence tier | Status |
|---|---|---|---|---|
| `live-links/` | A running app at BASE_URL | crawler routes/pages/click-graph | `live_observed` 0.95 | ✅ wraps scripts/crawler |
| `codebase/` | A local source-code repo | files, classes, functions, routes, models | `ast` 0.90 (deterministic) or `graph_extracted` 0.65 (graphify) | 🚧 wraps scripts/graphify + new AST extractor |
| `openapi/` | `/openapi.json` on the target | endpoints + schemas | `spec` 0.95 | planned |
| `git-repos/` | Local git repo | recent changes, blame, file history | `code_only` 0.40 | planned |
| `jira-projects/` | Jira REST API | stories, bugs, acceptance criteria | `docs_extracted` 0.55 | planned |
| `confluence/` | Confluence REST API | docs, requirements | `docs_extracted` 0.55 | planned |
| `tribal-knowledge/` | Local markdown folder | tribal notes, gotchas | `docs_extracted` 0.55 | planned |
| `qa-bot/` | LLM Q&A over the KB | answered questions | `user_answered` 0.85 | deferred |
