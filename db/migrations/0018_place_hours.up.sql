-- Opening hours as FACTS about a place: what a source said, where and when we read it, and how
-- far we trust it. A check-in's "was it open?" answer is a fact too (source 'check-in').
--
--   kind 'schedule'     a normalized weekly schedule (apps/api/src/hours/schedule.ts, v1) for one
--                       of the venue's services ('regular', 'kitchen', 'bar'). One current
--                       schedule per place, service and source: a re-fetch replaces it (by
--                       whoever imports later, not the API).
--   kind 'observation'  a person's answer after checking in: the venue was open, closed, or they
--                       didn't check (was_open NULL). One per quest; the first answer stands.
--
-- A place with no schedule fact has UNKNOWN hours, never closed. Nothing may read "no row" as
-- "closed".
--
-- Additive: a new table and no change to an existing one, so pods from before this migration
-- run on it unchanged (they never touch it). It must be applied BEFORE the new API pods start:
-- today() joins it, and without the table every request fails.
--
-- Grants: the API's role inserts (check-in observations) and reads, and never updates or deletes
-- (docs/decisions/0003). NO grant to the ingest role, on purpose: no importer exists, and none
-- may run until the owner has approved a source's licensing. The PR that adds an importer adds
-- its own grant. The demo reset needs none: it deletes the demo account's quests, and the
-- quest_id of any fact goes NULL through the foreign key (which runs as the table's owner).
CREATE TABLE place_hours_facts (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  place_id    bigint      NOT NULL REFERENCES places (id) ON DELETE CASCADE,
  kind        text        NOT NULL CHECK (kind IN ('schedule', 'observation')),
  -- Which of the venue's services a schedule describes; observations are about the venue being open at all.
  service     text        NOT NULL DEFAULT 'regular' CHECK (service IN ('regular', 'kitchen', 'bar')),
  source      text        NOT NULL CHECK (source IN ('osm', 'website', 'nyc_open_data', 'alltheplaces', 'manual', 'check-in')),
  source_url  text,                     -- where it was read; NULL for a check-in
  source_ref  text,                     -- the source's own id for the place (e.g. an OSM element), if any
  fetched_at  timestamptz NOT NULL,     -- when we read it; for a check-in, when the person checked in
  confidence  real        NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  raw         text,                     -- the source's own text, for re-parsing
  schedule    jsonb,                    -- kind = 'schedule': the normalized schedule (v1)
  was_open    boolean,                  -- kind = 'observation': true / false; NULL = "didn't check"
  quest_id    bigint                 REFERENCES quests (id) ON DELETE SET NULL,
  user_id     bigint                 REFERENCES users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'schedule') = (schedule IS NOT NULL)),
  CHECK ((kind = 'observation') = (source = 'check-in')),
  CHECK (kind = 'schedule' OR service = 'regular')
);

CREATE INDEX place_hours_facts_place ON place_hours_facts (place_id);
-- One answer per quest.
CREATE UNIQUE INDEX place_hours_facts_quest ON place_hours_facts (quest_id) WHERE quest_id IS NOT NULL;
-- One current schedule per source per service.
CREATE UNIQUE INDEX place_hours_facts_schedule ON place_hours_facts (place_id, service, source) WHERE kind = 'schedule';

GRANT SELECT, INSERT ON place_hours_facts TO larper_api;
