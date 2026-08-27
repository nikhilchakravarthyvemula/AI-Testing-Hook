-- ============================================================================
-- Embeddings (optional now — run only when pgvector is enabled on the instance
-- and an embedding model is actually available). Content-addressed: vectors are
-- shared across scans; embedding_ref maps scan entities onto them.
-- Cloud SQL: enable via `CREATE EXTENSION vector;` (requires the flag/support).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS embedding (
  id           uuid PRIMARY KEY,
  project_id   uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  model        text NOT NULL,
  chunk_text   text NOT NULL,
  vec          vector NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, content_hash, model)
);
-- Per-model partial HNSW indexes are created when a model is chosen, e.g.:
-- CREATE INDEX embedding_hnsw_<model> ON embedding
--   USING hnsw ((vec::vector(1536)) vector_cosine_ops) WHERE model = '<model-id>';

CREATE TABLE IF NOT EXISTS embedding_ref (
  scan_id      uuid NOT NULL REFERENCES scan(id) ON DELETE CASCADE,
  entity_type  text NOT NULL,
  entity_ref   text NOT NULL,
  embedding_id uuid NOT NULL REFERENCES embedding(id) ON DELETE CASCADE,
  PRIMARY KEY (scan_id, entity_type, entity_ref, embedding_id)
);
CREATE INDEX IF NOT EXISTS embedding_ref_embedding_ix ON embedding_ref (embedding_id);
