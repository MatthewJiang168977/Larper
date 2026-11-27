-- Place reliability (docs/plans/quality-engine.md, section 2): what people reported about a
-- place, and the reliability-worker's estimate that it is open and as described.
--
-- Additive for old pods, except delete_my_history, which now also removes the user's
-- reports and returns what it returned before. Apply BEFORE the new API and
-- reliability-worker pods start: today() reads place_reliability.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'larper_reliability') THEN
    BEGIN
      CREATE ROLE larper_reliability NOLOGIN;
    EXCEPTION WHEN duplicate_object THEN
      NULL; -- CNPG created it between the check and here
    END;
  END IF;
END $$;

-- The evidence, one row per report (the PlaceReport event's id). Hand verdicts carry no user.
CREATE TABLE place_reports (
  event_id    uuid        PRIMARY KEY,
  place_id    bigint      NOT NULL REFERENCES places (id) ON DELETE CASCADE,
  user_id     bigint               REFERENCES users (id) ON DELETE CASCADE,
  quest_id    bigint,     -- the visit; no foreign key, so a visit's reports stay grouped
  kind        text        NOT NULL CHECK (kind IN
                ('checked_in', 'confirmed_open', 'wasnt_open', 'skipped_closed', 'hand_verified', 'hand_closed')),
  occurred_at timestamptz NOT NULL,
  CHECK ((kind IN ('hand_verified', 'hand_closed')) = (user_id IS NULL))
);
CREATE INDEX place_reports_place ON place_reports (place_id);
CREATE INDEX place_reports_user ON place_reports (user_id) WHERE user_id IS NOT NULL;

-- The estimate, recomputed from all of a place's reports. successes and failures are the
-- weighted evidence as it stood at as_of; readers decay it to now. suspended_at is sticky:
-- only a later hand verification lifts it. stale: the evidence changed without an event
-- (a history deletion, the backfill), so the worker recomputes it.
CREATE TABLE place_reliability (
  place_id     bigint      PRIMARY KEY REFERENCES places (id) ON DELETE CASCADE,
  successes    real        NOT NULL DEFAULT 0 CHECK (successes >= 0),
  failures     real        NOT NULL DEFAULT 0 CHECK (failures >= 0),
  as_of        timestamptz NOT NULL DEFAULT now(),
  suspended_at timestamptz,
  stale        boolean     NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX place_reliability_stale ON place_reliability (place_id) WHERE stale;
CREATE INDEX place_reliability_suspended ON place_reliability (place_id) WHERE suspended_at IS NOT NULL;

GRANT SELECT ON place_reports, place_reliability TO larper_api;
GRANT USAGE ON SCHEMA public TO larper_reliability;
GRANT SELECT, INSERT         ON place_reports     TO larper_reliability;
GRANT SELECT, INSERT, UPDATE ON place_reliability TO larper_reliability;
GRANT INSERT                 ON processed_events  TO larper_reliability;
-- Takes the user -> quest locks, as the taste worker does, so a report in flight never
-- outlives a deletion.
GRANT EXECUTE ON FUNCTION lock_user_quest(bigint, bigint) TO larper_reliability;

-- delete_my_history (0020), now also removing the user's reports. The places they touched are
-- marked stale; a suspension they caused stays until a hand verification.
CREATE OR REPLACE FUNCTION delete_my_history(p_user_id bigint) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n_attempts bigint;
  n_answers  bigint;
  n_saved    bigint;
  n_quests   bigint;
  n_events   bigint;
BEGIN
  -- Wait for existing quest writers and workers before taking any child locks.
  -- Account deletion holds this lock through the outbox sweep and the user DELETE,
  -- so even a new offer's FK check cannot pass in between.
  PERFORM 1 FROM users WHERE id = p_user_id FOR UPDATE;

  WITH gone AS (DELETE FROM place_reports WHERE user_id = p_user_id RETURNING place_id)
  INSERT INTO place_reliability (place_id, stale)
  SELECT DISTINCT place_id, true FROM gone
  -- Locked in place order, so two deletions sharing places can't deadlock.
  ORDER BY place_id
  ON CONFLICT (place_id) DO UPDATE SET stale = true;

  -- Attempts reach a person only through their quest (0014): count them, then the quest
  -- delete cascades to them.
  SELECT count(*) INTO n_attempts FROM checkin_attempts a JOIN quests q ON q.id = a.quest_id WHERE q.user_id = p_user_id;

  -- Before the quests: place_hours_facts.quest_id would only go NULL, leaving the answer.
  WITH gone AS (DELETE FROM place_hours_facts WHERE user_id = p_user_id AND kind = 'observation' RETURNING 1)
  SELECT count(*) INTO n_answers FROM gone;
  WITH gone AS (DELETE FROM saved_places WHERE user_id = p_user_id RETURNING 1)
  SELECT count(*) INTO n_saved FROM gone;
  WITH gone AS (DELETE FROM quests WHERE user_id = p_user_id RETURNING 1)
  SELECT count(*) INTO n_quests FROM gone;
  -- The outbox key is the user id as text (events/outbox.ts). Rows the relay holds a lock
  -- on make this wait until it commits.
  WITH gone AS (DELETE FROM outbox WHERE key = p_user_id::text RETURNING 1)
  SELECT count(*) INTO n_events FROM gone;

  RETURN jsonb_build_object(
    'quests', n_quests, 'checkInAttempts', n_attempts, 'hoursAnswers', n_answers,
    'savedPlaces', n_saved, 'events', n_events);
END
$$;

-- Backfill what is already on file: "was it open?" answers and the curator's verdicts. Not
-- "closed" skips: SQL can't tell the shared demo account's from a person's.
INSERT INTO place_reports (event_id, place_id, user_id, quest_id, kind, occurred_at)
SELECT gen_random_uuid(), place_id, user_id, quest_id,
       CASE WHEN was_open THEN 'confirmed_open' ELSE 'wasnt_open' END, fetched_at
FROM place_hours_facts WHERE kind = 'observation' AND was_open IS NOT NULL;
INSERT INTO place_reports (event_id, place_id, kind, occurred_at)
SELECT gen_random_uuid(), place_id, CASE WHEN kind = 'closed' THEN 'hand_closed' ELSE 'hand_verified' END, created_at
FROM place_facts WHERE kind IN ('great', 'verified', 'closed');
INSERT INTO place_reliability (place_id, stale) SELECT DISTINCT place_id, true FROM place_reports;
