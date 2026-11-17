-- The "want to go" list: accepting a quest also saves its place here, in the same
-- transaction (QuestsService.act), and GET /saved-places reads it back, newest first.
-- One row per user and place: accepting another quest at the same place later changes
-- nothing. quest_id is the quest that saved it, kept for the record; it goes NULL if the
-- quest is deleted (the demo's nightly reset deletes the demo account's quests), and the
-- row goes with the user or the place.
--
-- Additive: a new table and no change to an existing one, so pods from before this
-- migration run on it unchanged (they never touch it). It must be applied BEFORE the new
-- API pods start: accept writes to it, and without the table every accept fails.
--
-- The API's role inserts and reads, and never updates or deletes (docs/decisions/0003).
-- The demo reset deletes the demo account's saved places beside its quests, so the next
-- visitor starts with an empty list (apps/api/src/ops/demo-reset.ts; migrations 0012/0013).
CREATE TABLE saved_places (
  user_id    bigint      NOT NULL REFERENCES users (id)  ON DELETE CASCADE,
  place_id   bigint      NOT NULL REFERENCES places (id) ON DELETE CASCADE,
  quest_id   bigint               REFERENCES quests (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, place_id)
);

GRANT SELECT, INSERT ON saved_places TO larper_api;
-- DELETE ... WHERE user_id = (SELECT id FROM users WHERE clerk_id = $1), like quests.
GRANT SELECT, DELETE ON saved_places TO larper_demo_reset;
