-- Export and delete my data (docs/decisions/0005-data-deletion.md).
--
-- 1. quests.origin is the exact position the user was at when an offer was made. It is
--    only read while the offer is open (the stale-offer check), so it is dropped, to NULL,
--    once the offer is resolved: expired, completed or skipped. That needs the column to
--    allow NULL. Old pods never write NULL and never read origin of a closed quest, so
--    they run on this unchanged; apply it BEFORE the new API pods start, since those
--    write NULL.
--
-- 2. The API's role still has no DELETE grant (docs/decisions/0003). Deleting a user's own
--    data goes through SECURITY DEFINER functions, like prune_checkin_attempts() (0014):
--    they run as the table owner (the migration role), pin search_path, and are granted to
--    larper_api only. Each takes our users.id, which the API reads from the verified
--    session, never from the request. The API also had no SELECT on checkin_attempts, so
--    the export reads a user's attempts through a function too, not a grant.
ALTER TABLE quests ALTER COLUMN origin DROP NOT NULL;
UPDATE quests SET origin = NULL WHERE origin IS NOT NULL AND status IN ('expired', 'completed', 'skipped');

-- Deletes the user's history and keeps the account and the taste profile: journal
-- (quests, and through them check-in attempts), "was it open?" answers, the want-to-go
-- list, and the user's outbox events (their payloads name quests and places). Returns
-- how many of each went.
CREATE FUNCTION delete_my_history(p_user_id bigint) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n_attempts bigint;
  n_answers  bigint;
  n_saved    bigint;
  n_quests   bigint;
  n_events   bigint;
BEGIN
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

-- Deletes everything about the user, including the users row. History first; then the
-- taste profile and any other row that still points at the user go with the users row
-- (ON DELETE CASCADE: taste_profiles, quests, saved_places, place_hours_facts). Returns
-- the counts from delete_my_history, plus whether a users row went.
CREATE FUNCTION delete_my_account(p_user_id bigint) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  history jsonb;
  n_taste bigint;
  n_users bigint;
BEGIN
  history := delete_my_history(p_user_id);
  WITH gone AS (DELETE FROM taste_profiles WHERE user_id = p_user_id RETURNING 1)
  SELECT count(*) INTO n_taste FROM gone;
  WITH gone AS (DELETE FROM users WHERE id = p_user_id RETURNING 1)
  SELECT count(*) INTO n_users FROM gone;
  RETURN history || jsonb_build_object('tasteProfile', n_taste > 0, 'account', n_users > 0);
END
$$;

-- The export's check-in attempts for one user, through their quests. No coordinates are
-- stored on an attempt, only distances.
CREATE FUNCTION export_my_checkin_attempts(p_user_id bigint)
  RETURNS TABLE (quest_id bigint, outcome checkin_outcome, distance_m real, accuracy_m real,
                 allowed_m real, demo boolean, created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT a.quest_id, a.outcome, a.distance_m, a.accuracy_m, a.allowed_m, a.demo, a.created_at
  FROM checkin_attempts a JOIN quests q ON q.id = a.quest_id
  WHERE q.user_id = p_user_id
  ORDER BY a.created_at, a.id
$$;

REVOKE ALL ON FUNCTION delete_my_history(bigint), delete_my_account(bigint), export_my_checkin_attempts(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_my_history(bigint), delete_my_account(bigint), export_my_checkin_attempts(bigint) TO larper_api;
