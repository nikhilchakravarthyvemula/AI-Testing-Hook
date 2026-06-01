"""Source extractors — one per source kind.

Each source has its own subdirectory implementing the
`SourceExtractor` Protocol from `base.py`:

  * `codebase/`      — source files on disk (the most-used foundation)
  * `live/`          — running application (OpenAPI fetch + browser crawl)
  * `docs/`          — markdown / Confluence / Notion content
  * `diagrams/`      — Mermaid / image-based architecture diagrams
  * `user/`          — questionnaire + runtime answers
  * `existing_tests/` — human-authored test files as a source of intent

All sources produce the same `ExtractionResult` shape; each carries
its own per-source request type.
"""
