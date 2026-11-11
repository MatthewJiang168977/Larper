-- The facts about a quest that its status can't say, so a user's profile stats can be
-- recomputed from Postgres alone (docs/milestones/M9-plan.md, Phase 1).
--
-- accepted_at   when it was accepted. A skipped quest may or may not have been.
-- completed_at  when it was checked in.
-- rarity        the rarity part of its score when it was offered, in [0, 1]. An area's
--               rarity changes when places are reloaded, so it's kept from the offer.
--
-- All NULL on older rows, and on rows old pods write during a rollout. A completed
-- quest's updated_at is its check-in time (completed is terminal), and completing needs
-- an accept, so only rarity is really unknown for those. The API's role can already
-- write quests, so there are no grants here.
ALTER TABLE quests
  ADD COLUMN accepted_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN rarity real;
