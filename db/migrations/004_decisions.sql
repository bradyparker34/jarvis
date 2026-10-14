-- The part that makes this a brain rather than a search index.
--
-- A decision records what was chosen, what context was in front of whoever
-- chose it, and what they expected to happen. An outcome records what actually
-- happened. With both, you can ask questions no notes app can answer:
--
--   Which of my sources produce deals that underperform?
--   When I say I am 80% sure, how often am I right?
--   What did my agent actually read before it told me to buy that?
--
-- Prediction is mandatory in practice: a decision with no expected outcome can
-- never be scored, so it teaches you nothing.

CREATE TYPE decision_status AS ENUM ('open', 'decided', 'executed', 'reversed', 'abandoned');
CREATE TYPE outcome_verdict AS ENUM ('better', 'as_expected', 'worse', 'unknown');

CREATE TABLE decisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id      text NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  title         text NOT NULL,
  question      text NOT NULL,                 -- the call being made, in one line
  options       jsonb NOT NULL DEFAULT '[]',   -- what was on the table
  chosen        text,
  rationale     text,
  status        decision_status NOT NULL DEFAULT 'open',
  -- Who made it. 'brady', or 'agent:buy-desk' when an agent did.
  decided_by    text,
  decided_at    timestamptz,
  -- What was expected, so it can be graded later.
  -- {"metric":"days_to_sell","value":35,"by":"2026-12-01"}
  prediction    jsonb,
  -- Stated confidence at decision time, 0-1. Feeds the calibration view.
  confidence    real CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  -- What is at risk. Lets you weight lessons by what they cost.
  stakes_usd    numeric,
  reversible    boolean NOT NULL DEFAULT true,
  subject_id    uuid REFERENCES entities(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX decisions_space_idx ON decisions (space_id, created_at DESC);
CREATE INDEX decisions_status_idx ON decisions (status) WHERE status IN ('open', 'decided', 'executed');

-- Exactly what context fed the decision. Without this you cannot tell a good
-- call made on thin information from a lucky guess.
CREATE TABLE decision_inputs (
  decision_id   uuid NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  object_type   text NOT NULL,                 -- 'event','claim','entity','retrieval'
  object_id     uuid NOT NULL,
  weight        real NOT NULL DEFAULT 1.0,     -- how much it mattered
  note          text,
  PRIMARY KEY (decision_id, object_type, object_id)
);

CREATE TABLE outcomes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id   uuid NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  observed_at   timestamptz NOT NULL DEFAULT now(),
  metric        text NOT NULL,
  predicted_value numeric,
  actual_value  numeric,
  verdict       outcome_verdict NOT NULL DEFAULT 'unknown',
  notes         text,
  recorded_by   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outcomes_decision_idx ON outcomes (decision_id);

-- Every query an agent ran, and what came back. The answer to "why did it say
-- that" six weeks later, and the raw material for noticing that an agent keeps
-- missing a particular corner of the graph.
CREATE TABLE retrievals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caller        text NOT NULL,                 -- 'claude-desktop', 'agent:buy-desk', 'cursor'
  query         text,
  spaces        text[],
  cross_space   boolean NOT NULL DEFAULT false,
  result_ids    uuid[] NOT NULL DEFAULT '{}',
  result_count  integer NOT NULL DEFAULT 0,
  latency_ms    integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retrievals_caller_idx ON retrievals (caller, created_at DESC);

-- ------------------------------------------------------------------ views

-- How decisions turned out, cut by space. The quarterly honesty check.
CREATE OR REPLACE VIEW decision_scorecard AS
  SELECT d.space_id,
         count(*) FILTER (WHERE d.status <> 'abandoned')            AS decisions,
         count(*) FILTER (WHERE o.verdict = 'better')               AS better,
         count(*) FILTER (WHERE o.verdict = 'as_expected')          AS as_expected,
         count(*) FILTER (WHERE o.verdict = 'worse')                AS worse,
         count(*) FILTER (WHERE o.id IS NULL
                          AND d.status IN ('decided', 'executed'))  AS ungraded,
         round(avg(o.actual_value - o.predicted_value)::numeric, 2) AS avg_miss,
         sum(d.stakes_usd) FILTER (WHERE o.verdict = 'worse')       AS stakes_on_misses
  FROM decisions d
  LEFT JOIN outcomes o ON o.decision_id = d.id
  GROUP BY d.space_id;

-- Are you as sure as you think you are? Buckets stated confidence against how
-- often the call actually landed. If the 90% bucket hits 60% of the time, every
-- agent prompt that trusts your confidence is miscalibrated too.
CREATE OR REPLACE VIEW calibration AS
  SELECT d.space_id,
         width_bucket(d.confidence, 0, 1, 5) AS confidence_bucket,
         round((width_bucket(d.confidence, 0, 1, 5) - 0.5) * 20)::text || '%' AS stated,
         count(*) AS n,
         round(
           100.0 * count(*) FILTER (WHERE o.verdict IN ('better', 'as_expected'))
           / nullif(count(*) FILTER (WHERE o.verdict <> 'unknown'), 0)
         , 1) AS actual_hit_rate_pct
  FROM decisions d
  JOIN outcomes o ON o.decision_id = d.id
  WHERE d.confidence IS NOT NULL
  GROUP BY d.space_id, 2
  ORDER BY d.space_id, 2;

-- Decisions whose prediction has come due with nothing recorded. The nag list,
-- and the thing that keeps the whole loop from quietly rotting.
CREATE OR REPLACE VIEW open_loops AS
  SELECT d.id, d.space_id, d.title, d.chosen, d.decided_at,
         (d.prediction ->> 'by')::timestamptz AS due,
         d.stakes_usd
  FROM decisions d
  WHERE d.status IN ('decided', 'executed')
    AND d.prediction ? 'by'
    AND (d.prediction ->> 'by')::timestamptz < now()
    AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.decision_id = d.id)
  ORDER BY d.stakes_usd DESC NULLS LAST, due;

-- Record an outcome and grade it in one call. Tolerance is the band inside
-- which a prediction counts as met, defaulting to 10%.
CREATE OR REPLACE FUNCTION record_outcome(
  _decision_id uuid,
  _metric text,
  _actual numeric,
  _notes text DEFAULT NULL,
  _recorded_by text DEFAULT 'brady',
  _tolerance real DEFAULT 0.10,
  -- For metrics where lower is better: days to sell, cost, time to close.
  _lower_is_better boolean DEFAULT false
)
RETURNS outcomes
LANGUAGE plpgsql AS $$
DECLARE
  pred numeric;
  v outcome_verdict;
  row_out outcomes;
BEGIN
  SELECT (prediction ->> 'value')::numeric INTO pred
  FROM decisions WHERE id = _decision_id;

  IF pred IS NULL OR _actual IS NULL THEN
    v := 'unknown';
  ELSIF abs(_actual - pred) <= abs(pred) * _tolerance THEN
    v := 'as_expected';
  ELSIF (_actual > pred) <> _lower_is_better THEN
    v := 'better';
  ELSE
    v := 'worse';
  END IF;

  INSERT INTO outcomes (decision_id, metric, predicted_value, actual_value,
                        verdict, notes, recorded_by)
  VALUES (_decision_id, _metric, pred, _actual, v, _notes, _recorded_by)
  RETURNING * INTO row_out;

  RETURN row_out;
END $$;
