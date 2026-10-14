-- Smoke test. Exercises the logic that is easy to get quietly wrong:
-- space isolation, the hard boundary on Bitdeer, provenance, the recursive
-- graph walk, and outcome grading in both directions.
--
-- Run against a scratch database. Prints PASS/FAIL per check.

\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

BEGIN;

-- ---------------------------------------------------------------- fixtures

INSERT INTO entities (id, kind, name, aliases) VALUES
  ('11111111-1111-1111-1111-111111111111', 'person', 'Tim Reinmann', '{"Tim"}'),
  ('22222222-2222-2222-2222-222222222222', 'person', 'Leo',          '{"Peng Li"}'),
  ('33333333-3333-3333-3333-333333333333', 'org',    'Acme Watches', '{}'),
  ('44444444-4444-4444-4444-444444444444', 'person', 'Dual Contact', '{}');

INSERT INTO identifiers (entity_id, kind, value) VALUES
  ('11111111-1111-1111-1111-111111111111', 'email', 'tim@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'email', 'leo@example.com');

INSERT INTO sources (id, space_id, kind, handle) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'scottsdale', 'manual', 'test'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'bitdeer',    'manual', 'test');

INSERT INTO events (id, space_id, source_id, kind, direction, occurred_at, subject, body, sensitivity) VALUES
  ('eeee0000-0000-0000-0000-000000000001', 'scottsdale', 'aaaaaaaa-0000-0000-0000-000000000001',
   'message', 'inbound', now() - interval '3 days',
   'Submariner 126610LN offer', 'Seller wants 9000 for a 126610LN, full set.', 'private'),
  ('eeee0000-0000-0000-0000-000000000002', 'bitdeer', 'aaaaaaaa-0000-0000-0000-000000000002',
   'email', 'inbound', now() - interval '2 days',
   'JMA hosting terms', 'Confidential hosting rate schedule for the Sealminer deal.', 'confidential');

INSERT INTO event_participants (event_id, entity_id, role) VALUES
  ('eeee0000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'from'),
  ('eeee0000-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444', 'cc'),
  ('eeee0000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'from'),
  ('eeee0000-0000-0000-0000-000000000002', '44444444-4444-4444-4444-444444444444', 'cc');

INSERT INTO claims (id, space_id, subject_id, predicate, object_text, origin, confidence) VALUES
  ('cccc0000-0000-0000-0000-000000000001', 'scottsdale',
   '11111111-1111-1111-1111-111111111111', 'prefers', 'wire transfer over credit card', 'stated', 0.9);

INSERT INTO claim_sources (claim_id, event_id, quote) VALUES
  ('cccc0000-0000-0000-0000-000000000001', 'eeee0000-0000-0000-0000-000000000001', 'full set');

INSERT INTO edges (from_id, to_id, kind, space_id, weight) VALUES
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'works_at', 'scottsdale', 2.0),
  ('33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', 'introduced', 'scottsdale', 1.0);

-- ------------------------------------------------------------------ checks

SELECT CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END
       || ' keyword search finds the watch event'
FROM search_events('Submariner', ARRAY['scottsdale']);

-- The hard boundary: a cross-space sweep must not surface Bitdeer, because
-- that space is marked unshareable.
SELECT CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END
       || ' cross-space search excludes unshareable Bitdeer'
FROM search_events('hosting', NULL, true);

-- Naming it outright still works, which is the intended escape hatch.
SELECT CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END
       || ' Bitdeer is readable when named explicitly'
FROM search_events('hosting', ARRAY['bitdeer']);

-- Sensitivity ceiling: asking for 'private' max must drop a confidential row.
SELECT CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END
       || ' sensitivity ceiling filters confidential rows'
FROM search_events('hosting', ARRAY['bitdeer'], false, 20, 'private');

-- Participation counters are maintained by trigger, and one contact appearing
-- in two businesses must show up in both.
SELECT CASE WHEN count(*) = 2 THEN 'PASS' ELSE 'FAIL' END
       || ' shared contact is tracked in both spaces'
FROM entity_spaces WHERE entity_id = '44444444-4444-4444-4444-444444444444';

SELECT CASE WHEN count(*) = 1 AND min(source_count) = 1 THEN 'PASS' ELSE 'FAIL' END
       || ' dossier returns the claim with its provenance'
FROM entity_dossier('11111111-1111-1111-1111-111111111111', ARRAY['scottsdale']);

-- Two hops: Tim -> Acme -> Dual Contact.
SELECT CASE WHEN count(*) >= 2 THEN 'PASS' ELSE 'FAIL' END
       || ' graph walk reaches two hops'
FROM graph_neighbors('11111111-1111-1111-1111-111111111111', 2, ARRAY['scottsdale']);

-- --------------------------------------------------- decision/outcome loop

INSERT INTO decisions (id, space_id, title, question, chosen, status, decided_by,
                       decided_at, prediction, confidence, stakes_usd)
VALUES
  ('dddd0000-0000-0000-0000-000000000001', 'scottsdale',
   'Buy 126610LN at 9000', 'Buy or pass?', 'BUY', 'executed', 'brady', now() - interval '40 days',
   '{"metric":"days_to_sell","value":35,"by":"2000-01-01"}'::jsonb, 0.8, 9000),
  ('dddd0000-0000-0000-0000-000000000002', 'scottsdale',
   'Buy Daytona at 11500', 'Buy or pass?', 'BUY', 'executed', 'brady', now() - interval '10 days',
   '{"metric":"days_to_sell","value":30,"by":"2000-01-01"}'::jsonb, 0.9, 11500);

INSERT INTO decision_inputs (decision_id, object_type, object_id, note) VALUES
  ('dddd0000-0000-0000-0000-000000000001', 'event',
   'eeee0000-0000-0000-0000-000000000001', 'the original offer');

-- Sold in 30 days against a 35-day prediction. Fewer days is better, so this
-- is a win, and the sign handling is the bit worth testing.
SELECT CASE WHEN (record_outcome('dddd0000-0000-0000-0000-000000000001',
                                 'days_to_sell', 30, NULL, 'test', 0.10, true)).verdict = 'better'
            THEN 'PASS' ELSE 'FAIL' END
       || ' selling faster than predicted grades as better';

-- Sold in 60 against 30: clearly worse.
SELECT CASE WHEN (record_outcome('dddd0000-0000-0000-0000-000000000002',
                                 'days_to_sell', 60, NULL, 'test', 0.10, true)).verdict = 'worse'
            THEN 'PASS' ELSE 'FAIL' END
       || ' selling slower than predicted grades as worse';

SELECT CASE WHEN better = 1 AND worse = 1 THEN 'PASS' ELSE 'FAIL' END
       || ' scorecard tallies both outcomes'
FROM decision_scorecard WHERE space_id = 'scottsdale';

-- 0.8 and 0.9 share the top bucket, so this is one row covering two decisions,
-- one of which landed: a stated ~90% confidence running at 50% in reality.
SELECT CASE WHEN count(*) = 1 AND max(n) = 2 AND max(actual_hit_rate_pct) = 50.0
            THEN 'PASS' ELSE 'FAIL' END
       || ' calibration pools same-confidence decisions and scores the hit rate'
FROM calibration WHERE space_id = 'scottsdale';

-- A decision past due with no outcome should appear; both of ours are graded,
-- so the list must be empty.
SELECT CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END
       || ' open_loops is empty once everything is graded'
FROM open_loops;

INSERT INTO decisions (space_id, title, question, chosen, status, decided_at, prediction)
VALUES ('scottsdale', 'Ungraded call', 'Buy or pass?', 'BUY', 'executed', now() - interval '5 days',
        '{"metric":"days_to_sell","value":20,"by":"2000-01-01"}'::jsonb);

SELECT CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END
       || ' open_loops catches the overdue ungraded decision'
FROM open_loops;

ROLLBACK;
