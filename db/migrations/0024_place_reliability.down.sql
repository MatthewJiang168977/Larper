-- Takes 0024 back. Roll the API and reliability-worker back first. The role stays:
-- CloudNativePG manages it (see 0010's down).

-- delete_my_history as 0020 wrote it.
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

REVOKE EXECUTE ON FUNCTION lock_user_quest(bigint, bigint) FROM larper_reliability;
DROP TABLE place_reliability;
DROP TABLE place_reports;
REVOKE INSERT ON processed_events FROM larper_reliability;
REVOKE USAGE ON SCHEMA public FROM larper_reliability;
