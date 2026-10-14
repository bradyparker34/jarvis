-- Semantic layer. Needs pgvector; the Docker image ships with it.
--
-- Embeddings live in their own table rather than as a column on events, so a
-- better model can be swapped in later without rewriting the log. Several
-- models can coexist during a migration.
--
-- 384 dimensions matches all-MiniLM-L6-v2, which runs locally on CPU with no
-- API key. Swap EMBED_MODEL and the dimension together if you move to a
-- hosted model.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE embeddings (
  object_type   text NOT NULL,                 -- 'event','claim','entity','decision'
  object_id     uuid NOT NULL,
  model         text NOT NULL,
  embedding     vector(384) NOT NULL,
  -- Denormalised so the vector scan can filter without joining back.
  space_id      text NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  sensitivity   sensitivity NOT NULL DEFAULT 'private',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (object_type, object_id, model)
);

-- Cosine distance, which is what sentence-transformers are trained for.
CREATE INDEX embeddings_vec_idx ON embeddings
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX embeddings_scope_idx ON embeddings (space_id, object_type);

-- Anything still waiting to be embedded. The embed worker drains this.
CREATE OR REPLACE VIEW embedding_backlog AS
  SELECT 'event' AS object_type, e.id AS object_id, e.space_id, e.sensitivity,
         concat_ws(E'\n', e.subject, e.body) AS content
  FROM events e
  WHERE length(coalesce(e.subject, '') || coalesce(e.body, '')) > 0
    AND NOT EXISTS (
      SELECT 1 FROM embeddings m
      WHERE m.object_type = 'event' AND m.object_id = e.id
    )
  UNION ALL
  SELECT 'claim', c.id, c.space_id, c.sensitivity,
         concat_ws(' ', c.predicate, c.object_text)
  FROM claims c
  WHERE c.superseded_by IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM embeddings m
      WHERE m.object_type = 'claim' AND m.object_id = c.id
    )
  UNION ALL
  SELECT 'entity', en.id, es.space_id, en.sensitivity,
         concat_ws(E'\n', en.name, array_to_string(en.aliases, ', '), en.summary)
  FROM entities en
  JOIN LATERAL (
    SELECT space_id FROM entity_spaces WHERE entity_id = en.id
    ORDER BY event_count DESC LIMIT 1
  ) es ON true
  WHERE NOT EXISTS (
    SELECT 1 FROM embeddings m
    WHERE m.object_type = 'entity' AND m.object_id = en.id
  );

-- Hybrid recall: keyword and vector rankings fused with Reciprocal Rank Fusion.
--
-- RRF beats score-blending because the two rankers produce scores on scales
-- that have nothing to do with each other. Fusing on rank sidesteps that, and
-- needs no tuning constant beyond k, where 60 is the value from the original
-- paper and works fine here.
--
-- Pass _embedding NULL and it degrades to pure keyword search, which is what
-- happens before the embed worker has caught up.
CREATE OR REPLACE FUNCTION recall(
  _query text,
  _embedding vector(384) DEFAULT NULL,
  _spaces text[] DEFAULT NULL,
  _cross_space boolean DEFAULT false,
  _limit integer DEFAULT 20,
  _max_sensitivity sensitivity DEFAULT 'confidential',
  _since timestamptz DEFAULT NULL,
  _model text DEFAULT 'all-MiniLM-L6-v2'
)
RETURNS TABLE (
  object_type text, object_id uuid, space_id text,
  occurred_at timestamptz, title text, snippet text, score real
)
LANGUAGE sql STABLE AS $$
  WITH allowed AS (SELECT unnest(readable_spaces(_spaces, _cross_space)) AS s),
  kw AS (
    SELECT 'event'::text AS ot, e.id AS oid,
           row_number() OVER (
             ORDER BY ts_rank(e.search_tsv, websearch_to_tsquery('english', _query)) DESC
           ) AS rnk
    FROM events e
    JOIN allowed a ON a.s = e.space_id
    WHERE _query IS NOT NULL
      AND e.search_tsv @@ websearch_to_tsquery('english', _query)
      AND e.sensitivity <= _max_sensitivity
      AND (_since IS NULL OR e.occurred_at >= _since)
    LIMIT 100
  ),
  vec AS (
    SELECT m.object_type AS ot, m.object_id AS oid,
           row_number() OVER (ORDER BY m.embedding <=> _embedding) AS rnk
    FROM embeddings m
    JOIN allowed a ON a.s = m.space_id
    WHERE _embedding IS NOT NULL
      AND m.model = _model
      AND m.sensitivity <= _max_sensitivity
    ORDER BY m.embedding <=> _embedding
    LIMIT 100
  ),
  fused AS (
    SELECT ot, oid, sum(1.0 / (60 + rnk))::real AS score
    FROM (SELECT * FROM kw UNION ALL SELECT * FROM vec) r
    GROUP BY ot, oid
  )
  SELECT f.ot, f.oid,
         coalesce(e.space_id, c.space_id, 'unknown'),
         coalesce(e.occurred_at, c.created_at, en.created_at),
         coalesce(e.subject, c.predicate, en.name),
         left(coalesce(e.body, c.object_text, en.summary, ''), 400),
         f.score
  FROM fused f
  LEFT JOIN events e   ON f.ot = 'event'  AND e.id = f.oid
  LEFT JOIN claims c   ON f.ot = 'claim'  AND c.id = f.oid
  LEFT JOIN entities en ON f.ot = 'entity' AND en.id = f.oid
  WHERE (_since IS NULL OR coalesce(e.occurred_at, c.created_at, en.created_at) >= _since)
  ORDER BY f.score DESC
  LIMIT _limit
$$;
