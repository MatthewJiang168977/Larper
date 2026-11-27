-- "Worth it?" after a check-in (docs/plans/quality-engine.md, section 3). A column on the
-- quest, so history and account deletion already remove it with the quest, and the API's
-- role needs no new grant (it updates quests).
--
-- Additive: old pods never write or read it. Apply BEFORE the new API pods start, and roll
-- the taste-worker before the API: an old one commits past the new actions.
ALTER TABLE quests
  ADD COLUMN worth_it    text        CHECK (worth_it IN ('yes', 'meh', 'no')),
  ADD COLUMN worth_it_at timestamptz,
  ADD CONSTRAINT quests_worth_it_at CHECK ((worth_it IS NULL) = (worth_it_at IS NULL));
