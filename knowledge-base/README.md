# Knowledge Base

Single source of truth. Merges all `output/sources/*.json` into one unified
`output/knowledge.json` with per-fact provenance + confidence.

## Files

- `schema.mjs` — `DiscoveryTier` enum + `confidenceForTier()` (ported from
  testing-agent's `context_layer/models.py`)
- `build.mjs` — reads source JSONs, deduplicates, emits `knowledge.json`
- `store.mjs` — read/write helpers used by downstream layers

## Output shape (`knowledge.json`)

```json
{
  "version": 1,
  "generatedAt": "ISO",
  "target": { "baseUrl": "...", "codebasePath": "..." },
  "sources": [
    { "id": "live-links", "tier": "live_observed", "confidence": 0.95, "at": "ISO", "stats": {...} },
    { "id": "codebase-graphify", "tier": "graph_extracted", "confidence": 0.65, "at": "ISO", "stats": {...} },
    { "id": "codebase-ast",      "tier": "ast", "confidence": 0.90, "at": "ISO", "stats": {...} }
  ],
  "facts": {
    "endpoints": [...],
    "pages":     [...],
    "interactions": [...],
    "frameworks": [...]
  }
}
```
