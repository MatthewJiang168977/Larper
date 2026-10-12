-- The quest log. offered -> accepted -> completed, with skipped reachable from
-- offered/accepted and expired for offers that went stale (old, or the user moved).
CREATE TYPE quest_status AS ENUM ('offered', 'accepted', 'completed', 'skipped', 'expired');

CREATE TABLE quests (
  id         bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint       NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  place_id   bigint       NOT NULL REFERENCES places (id) ON DELETE CASCADE,
  status     quest_status NOT NULL DEFAULT 'offered',
  score      real         NOT NULL,
  reasons    jsonb        NOT NULL,            -- explanation shown on the card, frozen at offer time
  origin     geography(Point, 4326) NOT NULL,  -- where the user was when it was offered
  created_at timestamptz  NOT NULL DEFAULT now(),
  updated_at timestamptz  NOT NULL DEFAULT now()
);

-- At most one live quest per user. Two API replicas racing to offer one: the
-- second INSERT hits this index and re-reads the winner's row instead.
CREATE UNIQUE INDEX quests_one_active ON quests (user_id) WHERE status IN ('offered', 'accepted');
CREATE INDEX quests_user_recent ON quests (user_id, updated_at DESC);
