-- Every check-in attempt and how it ended, kept 90 days, so the deferred three-tier
-- decision (docs/decisions/0002-checkin-accuracy-tiers.md) can be made from real
-- numbers. The `checkin` log line carried the same fields, but logs go with the pod.
--
-- No coordinates: the distance to the place is all the rule uses. A row reaches a person
-- only through its quest, and goes with it (account deletion, the demo's nightly reset).
CREATE TYPE checkin_outcome AS ENUM
  ('accepted', 'too_far', 'too_rough', 'no_position', 'not_found', 'conflict', 'error');

CREATE TABLE checkin_attempts (
  id          bigint          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- NULL for not_found: the id may not exist or may be someone else's quest.
  quest_id    bigint          REFERENCES quests (id) ON DELETE CASCADE,
  outcome     checkin_outcome NOT NULL,
  -- NULL when no geofence was judged (no position, not found before the check).
  distance_m  real,
  accuracy_m  real,           -- NULL also when the phone reported none
  allowed_m   real,
  -- The shared demo account: visitors are mostly far from NYC, so its attempts say
  -- little about real fixes. Kept apart in the report, not dropped.
  demo        boolean         NOT NULL,
  created_at  timestamptz     NOT NULL DEFAULT now()
);

CREATE INDEX checkin_attempts_created_at ON checkin_attempts (created_at);
CREATE INDEX checkin_attempts_quest ON checkin_attempts (quest_id) WHERE quest_id IS NOT NULL;

-- Retention: the API calls this (on start and every few hours). SECURITY DEFINER, so
-- the API can drop rows past 90 days without a DELETE grant on the table: it still
-- never deletes anything else.
CREATE FUNCTION prune_checkin_attempts() RETURNS bigint
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH gone AS (DELETE FROM checkin_attempts WHERE created_at < now() - interval '90 days' RETURNING 1)
  SELECT count(*) FROM gone
$$;
REVOKE ALL ON FUNCTION prune_checkin_attempts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION prune_checkin_attempts() TO larper_api;

-- The API writes attempts and never reads them back; the report runs as the owner.
GRANT INSERT ON checkin_attempts TO larper_api;
