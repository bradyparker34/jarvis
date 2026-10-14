-- One authoritative answer to "which spaces may this call read".
--
-- 002 introduced readable_spaces(), and the SQL functions that use it honour
-- the boundary correctly. The leaks were never in those functions: they were in
-- hand-written queries in the tool handlers and the HTTP bridge that resolved
-- scope themselves, or not at all. who_is returned Bitdeer event bodies even
-- when asked for scottsdale outright.
--
-- The structural fix lives in TypeScript (one resolver every handler must go
-- through). This migration gives that resolver a validating entry point, so
-- the rule stays next to the data and any future SQL can reuse it.
--
-- readable_spaces() is left exactly as it is: it is correct, it is referenced
-- by four existing functions, and replacing it would be a behaviour change
-- dressed up as a refactor.

-- Same contract as readable_spaces(), with one addition: a named space that
-- does not exist is an error rather than silence.
--
-- Silence is the dangerous option here. `spaces: ['scotsdale']` currently
-- resolves to an empty set, every query returns nothing, and the agent reports
-- "nothing known about this person" — which is indistinguishable from the
-- truth and far worse than an error in a system whose whole job is recall.
CREATE OR REPLACE FUNCTION resolve_scope(_spaces text[], _cross_space boolean)
RETURNS text[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
  unknown text[];
BEGIN
  IF _spaces IS NOT NULL AND array_length(_spaces, 1) > 0 THEN
    SELECT array_agg(s ORDER BY s) INTO unknown
    FROM unnest(_spaces) AS s
    WHERE NOT EXISTS (SELECT 1 FROM spaces WHERE spaces.id = s);

    IF unknown IS NOT NULL THEN
      RAISE EXCEPTION 'unknown space(s): %; valid spaces are %',
        array_to_string(unknown, ', '),
        (SELECT string_agg(id, ', ' ORDER BY id) FROM spaces)
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  RETURN readable_spaces(_spaces, _cross_space);
END $$;

COMMENT ON FUNCTION resolve_scope(text[], boolean) IS
  'Validating wrapper over readable_spaces(). Every caller that reads '
  'space-scoped rows must resolve its scope through this and then filter on '
  'the returned array. Unknown space ids raise rather than returning empty.';

-- Which spaces are safe to hand to a third-party service. An unshareable space
-- is confidential by construction, so nothing in it goes over the network
-- regardless of what a provider env var says. Used by the embed worker.
CREATE OR REPLACE FUNCTION exportable_spaces()
RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(id ORDER BY id), '{}'::text[])
  FROM spaces
  WHERE shareable AND default_sensitivity <= 'private'
$$;

COMMENT ON FUNCTION exportable_spaces() IS
  'Spaces whose contents may be sent to a remote service. Row sensitivity is '
  'still checked per row; this is the space-level floor.';
