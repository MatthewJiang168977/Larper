-- An hours observation (kind 'observation', a check-in's "was it open?" answer) always has a
-- user: the confirmations count DISTINCT users, and a NULL user would count as nobody (or be
-- uncountable). The API has always set user_id on every observation (quests.service wasOpen
-- takes it from the authenticated user and now refuses without one), so no pod from before this
-- migration writes a row that breaks it. Schedule facts need no user.
--
-- Added NOT VALID and then validated in the same migration: the table is small (no importer
-- exists yet, only check-in answers), so the validating scan is short, and a row that already
-- broke the rule would fail the migration here rather than sit unnoticed.
ALTER TABLE place_hours_facts
  ADD CONSTRAINT place_hours_facts_observation_user
  CHECK (kind <> 'observation' OR user_id IS NOT NULL) NOT VALID;
ALTER TABLE place_hours_facts VALIDATE CONSTRAINT place_hours_facts_observation_user;
