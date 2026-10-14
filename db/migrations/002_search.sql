-- Keyword search. Deliberately separate from the vector layer so the system is
-- useful the moment data lands, before a single embedding has been computed.
--
-- Retrieval ends up as two rankers fused together (see 003): keywords catch
-- exact things — a reference number, a person's name, "126610LN" — and vectors
-- catch the fuzzy ones. Either alone is noticeably worse.

ALTER TABLE events ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) STORED;
CREATE INDEX events_search_idx ON events USING gin (search_tsv);

ALTER TABLE claims ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(predicate, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(object_text, '')), 'B')
  ) STORED;
CREATE INDEX claims_search_idx ON claims USING gin (search_tsv);

-- array_to_string is only STABLE, so it cannot appear in a generated column.
-- Wrapping it is safe for text[] -> text, which has no locale or settings
-- dependence, and keeps aliases inside the one search index.
CREATE OR REPLACE FUNCTION text_array_join(text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT array_to_string($1, ' ') $$;

ALTER TABLE entities ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', text_array_join(aliases)), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B')
  ) STORED;
CREATE INDEX entities_search_idx ON entities USING gin (search_tsv);

-- Trigram matching for names people spell three different ways. Optional: a
-- stripped-down Postgres without contrib still gets everything else, it just
-- loses fuzzy name matching.
DO $trgm$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS entities_name_trgm_idx
    ON entities USING gin (name gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm unavailable; skipping fuzzy name index';
END $trgm$;

-- Which spaces a caller may read. Honours the hard boundary on spaces.shareable:
-- a space marked unshareable is only ever readable when named outright.
CREATE OR REPLACE FUNCTION readable_spaces(_spaces text[], _cross_space boolean)
RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN _spaces IS NOT NULL AND array_length(_spaces, 1) > 0 THEN _spaces
    WHEN _cross_space THEN (SELECT array_agg(id) FROM spaces WHERE shareable)
    ELSE '{}'::text[]
  END
$$;

-- Keyword search over events.
CREATE OR REPLACE FUNCTION search_events(
  _query text,
  _spaces text[] DEFAULT NULL,
  _cross_space boolean DEFAULT false,
  _limit integer DEFAULT 20,
  _max_sensitivity sensitivity DEFAULT 'confidential'
)
RETURNS TABLE (
  id uuid, space_id text, kind event_kind, occurred_at timestamptz,
  subject text, body text, score real
)
LANGUAGE sql STABLE AS $$
  WITH allowed AS (SELECT unnest(readable_spaces(_spaces, _cross_space)) AS s)
  SELECT e.id, e.space_id, e.kind, e.occurred_at, e.subject, e.body,
         ts_rank(e.search_tsv, websearch_to_tsquery('english', _query))::real
  FROM events e
  JOIN allowed a ON a.s = e.space_id
  WHERE e.search_tsv @@ websearch_to_tsquery('english', _query)
    AND e.sensitivity <= _max_sensitivity
  ORDER BY 7 DESC, e.occurred_at DESC
  LIMIT _limit
$$;

-- Everything currently believed about one entity, newest first.
-- The function an agent calls before it opens its mouth about a person.
CREATE OR REPLACE FUNCTION entity_dossier(
  _entity_id uuid,
  _spaces text[] DEFAULT NULL,
  _cross_space boolean DEFAULT false,
  _max_sensitivity sensitivity DEFAULT 'confidential'
)
RETURNS TABLE (
  predicate text, object text, confidence real, origin claim_origin,
  space_id text, valid_from timestamptz, source_count bigint
)
LANGUAGE sql STABLE AS $$
  WITH allowed AS (SELECT unnest(readable_spaces(_spaces, _cross_space)) AS s)
  SELECT c.predicate,
         coalesce(c.object_text, o.name, c.object_num::text, c.object_time::text) AS object,
         c.confidence, c.origin, c.space_id, c.valid_from,
         (SELECT count(*) FROM claim_sources cs WHERE cs.claim_id = c.id)
  FROM claims c
  JOIN allowed a ON a.s = c.space_id
  LEFT JOIN entities o ON o.id = c.object_id
  WHERE c.subject_id = _entity_id
    AND c.superseded_by IS NULL
    AND c.sensitivity <= _max_sensitivity
  ORDER BY c.confidence DESC, c.created_at DESC
$$;

-- Walk the graph outward from an entity. Powers both the 3D map and the
-- "who connects me to this person" question.
CREATE OR REPLACE FUNCTION graph_neighbors(
  _entity_id uuid,
  _depth integer DEFAULT 1,
  _spaces text[] DEFAULT NULL,
  _cross_space boolean DEFAULT false,
  _limit integer DEFAULT 200
)
RETURNS TABLE (
  from_id uuid, from_name text, to_id uuid, to_name text,
  kind text, space_id text, weight real, hops integer
)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE allowed AS (
    SELECT unnest(readable_spaces(_spaces, _cross_space)) AS s
  ),
  walk AS (
    SELECT e.from_id, e.to_id, e.kind, e.space_id, e.weight, 1 AS hops
    FROM edges e
    WHERE (e.from_id = _entity_id OR e.to_id = _entity_id)
      AND e.ended_at IS NULL
      AND (e.space_id IS NULL OR e.space_id IN (SELECT s FROM allowed))
    UNION
    SELECT e.from_id, e.to_id, e.kind, e.space_id, e.weight, w.hops + 1
    FROM edges e
    JOIN walk w ON (e.from_id = w.to_id OR e.to_id = w.from_id)
    WHERE w.hops < _depth
      AND e.ended_at IS NULL
      AND (e.space_id IS NULL OR e.space_id IN (SELECT s FROM allowed))
  )
  SELECT DISTINCT w.from_id, f.name, w.to_id, t.name, w.kind, w.space_id, w.weight, w.hops
  FROM walk w
  JOIN entities f ON f.id = w.from_id
  JOIN entities t ON t.id = w.to_id
  ORDER BY w.hops, w.weight DESC
  LIMIT _limit
$$;
