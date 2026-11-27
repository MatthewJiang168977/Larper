-- Roll the API back first. The answers are gone for good.
ALTER TABLE quests
  DROP CONSTRAINT quests_worth_it_at,
  DROP COLUMN worth_it,
  DROP COLUMN worth_it_at;
