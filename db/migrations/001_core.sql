-- Jarvis core: the substrate every other layer builds on.
--
-- Three ideas carry the design:
--   1. EVENTS are an immutable log of things that happened. Never edited.
--   2. CLAIMS are atomic facts distilled from events, each pointing back at the
--      event(s) that produced it. Claims supersede each other over time, so the
--      brain can change its mind without losing the record of why it used to
--      think otherwise.
--   3. SPACES keep Bitdeer, meat and watches apart by default. Cross-space
--      reads are possible, but have to be asked for, and are logged.
--
-- Everything carries provenance. An agent that cannot say where a fact came
-- from has no business making decisions with it.

-- gen_random_uuid() is core Postgres from 13 onward, so there is no extension
-- dependency here at all. Keeps the core schema portable to any Postgres.

-- ------------------------------------------------------------------ enums

-- How confidential a row is. Agents filter on this, and export honours it.
CREATE TYPE sensitivity AS ENUM (
  'open',          -- fine anywhere
  'private',       -- personal, do not quote outside Jarvis
  'confidential',  -- someone else's commercial material
  'restricted'     -- never leaves this machine, never into a model prompt
);

CREATE TYPE event_kind AS ENUM (
  'message',       -- chat: telegram, slack, whatsapp, sms, imessage
  'email',
  'call',          -- voice, with or without a transcript
  'meeting',       -- calendar event, optionally with a transcript
  'note',          -- something Brady wrote down
  'document',      -- a file that arrived
  'transaction',   -- money moved, inventory sold
  'commitment',    -- a promise made, by either side
  'observation'    -- a system or agent noticed something
);

CREATE TYPE direction AS ENUM ('inbound', 'outbound', 'internal');

CREATE TYPE entity_kind AS ENUM (
  'person',
  'org',
  'deal',          -- a JMA, a watch purchase, a load of chicken
  'asset',         -- a watch reference, a miner model, a SKU
  'place',
  'account',       -- a bank or platform account
  'topic'          -- a recurring subject worth tracking
);

-- Where a fact came from, which drives how much to trust it.
CREATE TYPE claim_origin AS ENUM (
  'stated',        -- someone said it outright
  'extracted',     -- a model pulled it out of an event
  'derived',       -- computed from other claims
  'manual'         -- Brady entered it himself
);

-- ----------------------------------------------------------------- spaces

-- One row per arena of life. Isolation is the default; sharing is deliberate.
CREATE TABLE spaces (
  id            text PRIMARY KEY,              -- 'bitdeer', 'lawrence', 'scottsdale', 'personal'
  label         text NOT NULL,
  description   text,
  -- Default sensitivity applied to anything ingested into this space when the
  -- adapter does not set one. Bitdeer runs at 'confidential' for a reason.
  default_sensitivity sensitivity NOT NULL DEFAULT 'private',
  -- When false, no cross-space query may read this space's rows, ever, even
  -- when the caller asks. The hard boundary.
  shareable     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- sources

-- One row per connected feed: "gmail/brady personal", "telegram/main".
-- Holds the sync cursor so ingestion is resumable and idempotent.
CREATE TABLE sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id      text NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  kind          text NOT NULL,                 -- 'gmail','telegram','slack','imessage','whatsapp_export','calendar','transcript','files','manual'
  handle        text NOT NULL,                 -- which account this is
  cursor        jsonb NOT NULL DEFAULT '{}',   -- adapter-defined resume point
  last_synced_at timestamptz,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, handle, space_id)
);

-- --------------------------------------------------------------- entities

-- People, companies, deals, assets. Entities are global on purpose: the same
-- person can appear in two businesses, and pretending otherwise loses the most
-- interesting connections. Visibility is controlled per space below.
CREATE TABLE entities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          entity_kind NOT NULL,
  name          text NOT NULL,
  -- Other names for the same thing. Used by identity resolution.
  aliases       text[] NOT NULL DEFAULT '{}',
  attrs         jsonb NOT NULL DEFAULT '{}',
  -- A short, maintained description an agent can read instead of 400 events.
  summary       text,
  sensitivity   sensitivity NOT NULL DEFAULT 'private',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entities_kind_idx ON entities (kind);
CREATE INDEX entities_name_idx ON entities (lower(name));
CREATE INDEX entities_aliases_idx ON entities USING gin (aliases);

-- Which spaces an entity shows up in, and how central it is to each.
CREATE TABLE entity_spaces (
  entity_id     uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  space_id      text NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  role          text,                          -- 'supplier', 'buyer', 'colleague', 'partner'
  first_seen_at timestamptz,
  last_seen_at  timestamptz,
  event_count   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (entity_id, space_id)
);

-- The addresses an entity answers to. This is how a phone number in a text and
-- an email address in a thread become the same person.
CREATE TABLE identifiers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id     uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind          text NOT NULL,                 -- 'email','phone','telegram','slack','whatsapp','domain','handle'
  value         text NOT NULL,                 -- normalised: lowercased email, E.164 phone
  confidence    real NOT NULL DEFAULT 1.0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);
CREATE INDEX identifiers_entity_idx ON identifiers (entity_id);

-- ----------------------------------------------------------------- events

-- The immutable log. One row per thing that happened.
CREATE TABLE events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id      text NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  source_id     uuid REFERENCES sources(id) ON DELETE SET NULL,
  kind          event_kind NOT NULL,
  direction     direction,
  occurred_at   timestamptz NOT NULL,
  -- Natural key from the upstream system. Makes re-running ingestion safe.
  external_id   text,
  thread_id     text,                          -- groups a conversation
  subject       text,
  body          text,
  -- Everything the adapter knows that does not deserve a column.
  metadata      jsonb NOT NULL DEFAULT '{}',
  sensitivity   sensitivity NOT NULL DEFAULT 'private',
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  -- NULLS NOT DISTINCT matters more than it looks. By default Postgres treats
  -- NULL as unequal to itself, so a plain UNIQUE would let an event with no
  -- source_id be inserted again on every run — silently duplicating anything
  -- written directly by an agent rather than by an adapter. In a memory system
  -- that is corruption: the same fact starts outvoting others by sheer count.
  UNIQUE NULLS NOT DISTINCT (source_id, external_id)
);
CREATE INDEX events_space_time_idx ON events (space_id, occurred_at DESC);
CREATE INDEX events_kind_idx ON events (kind, occurred_at DESC);
CREATE INDEX events_thread_idx ON events (thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX events_metadata_idx ON events USING gin (metadata);

-- Who was on it. Separate table because events routinely have many parties.
CREATE TABLE event_participants (
  event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  entity_id     uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role          text NOT NULL DEFAULT 'participant', -- 'from','to','cc','organiser','mentioned'
  PRIMARY KEY (event_id, entity_id, role)
);
CREATE INDEX event_participants_entity_idx ON event_participants (entity_id);

-- Files that came with events. Content stays on disk; this is the index.
CREATE TABLE artifacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid REFERENCES events(id) ON DELETE CASCADE,
  space_id      text NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  filename      text NOT NULL,
  mime_type     text,
  bytes         bigint,
  sha256        text,
  storage_path  text NOT NULL,                 -- absolute path on this machine
  extracted_text text,
  sensitivity   sensitivity NOT NULL DEFAULT 'private',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_event_idx ON artifacts (event_id);
CREATE UNIQUE INDEX artifacts_sha_idx ON artifacts (sha256) WHERE sha256 IS NOT NULL;

-- ----------------------------------------------------------------- claims

-- Atomic facts. "Leo approves JMA terms above 15%." "124060 sells in 22 days."
-- A claim is never updated in place: a newer claim supersedes an older one, and
-- the old row stays so you can ask what you believed in March and why.
CREATE TABLE claims (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id      text NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  -- What the claim is about. Nullable: some claims are about the world, not a thing.
  subject_id    uuid REFERENCES entities(id) ON DELETE CASCADE,
  predicate     text NOT NULL,                 -- 'prefers','owes','reports_to','price_target','deadline'
  object_text   text,                          -- free-form value
  object_id     uuid REFERENCES entities(id) ON DELETE SET NULL,  -- when the value is another entity
  object_num    numeric,                       -- when the value is a number, so it can be compared
  object_time   timestamptz,                   -- when the value is a date
  origin        claim_origin NOT NULL,
  confidence    real NOT NULL DEFAULT 0.7,
  -- When this was true in the world, as opposed to when it was recorded.
  valid_from    timestamptz,
  valid_until   timestamptz,
  superseded_by uuid REFERENCES claims(id) ON DELETE SET NULL,
  sensitivity   sensitivity NOT NULL DEFAULT 'private',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claims_subject_idx ON claims (subject_id) WHERE superseded_by IS NULL;
CREATE INDEX claims_space_pred_idx ON claims (space_id, predicate) WHERE superseded_by IS NULL;
CREATE INDEX claims_live_idx ON claims (created_at DESC) WHERE superseded_by IS NULL;

-- Which events produced a claim. A claim with no provenance is a rumour.
CREATE TABLE claim_sources (
  claim_id      uuid NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  quote         text,                          -- the span the claim came from
  PRIMARY KEY (claim_id, event_id)
);

-- ------------------------------------------------------------------ edges

-- Typed relationships between entities. The thing the 3D map draws.
-- Edges are time-bounded: "supplied to" can stop being true.
CREATE TABLE edges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id       uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id         uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind          text NOT NULL,                 -- 'works_at','supplies','bought_from','introduced','competes_with'
  space_id      text REFERENCES spaces(id) ON DELETE CASCADE,  -- null = holds everywhere
  weight        real NOT NULL DEFAULT 1.0,     -- how strong, by interaction volume
  confidence    real NOT NULL DEFAULT 0.7,
  started_at    timestamptz,
  ended_at      timestamptz,
  source_event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  attrs         jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_id, to_id, kind, space_id)
);
CREATE INDEX edges_from_idx ON edges (from_id) WHERE ended_at IS NULL;
CREATE INDEX edges_to_idx ON edges (to_id) WHERE ended_at IS NULL;

-- ------------------------------------------------------------- ingest log

-- Idempotency and audit for every ingestion run.
CREATE TABLE ingest_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     uuid REFERENCES sources(id) ON DELETE CASCADE,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  events_seen   integer NOT NULL DEFAULT 0,
  events_new    integer NOT NULL DEFAULT 0,
  error         text
);

-- -------------------------------------------------------------- housekeeping

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER entities_touch BEFORE UPDATE ON entities
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Keep entity_spaces counters honest as events land.
CREATE OR REPLACE FUNCTION bump_entity_space() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ev events%ROWTYPE;
BEGIN
  SELECT * INTO ev FROM events WHERE id = NEW.event_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  INSERT INTO entity_spaces (entity_id, space_id, first_seen_at, last_seen_at, event_count)
  VALUES (NEW.entity_id, ev.space_id, ev.occurred_at, ev.occurred_at, 1)
  ON CONFLICT (entity_id, space_id) DO UPDATE SET
    first_seen_at = LEAST(entity_spaces.first_seen_at, EXCLUDED.first_seen_at),
    last_seen_at  = GREATEST(entity_spaces.last_seen_at, EXCLUDED.last_seen_at),
    event_count   = entity_spaces.event_count + 1;
  RETURN NEW;
END $$;

CREATE TRIGGER event_participants_bump AFTER INSERT ON event_participants
  FOR EACH ROW EXECUTE FUNCTION bump_entity_space();
