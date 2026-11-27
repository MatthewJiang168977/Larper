-- Facts a curator records about a place from the admin page (docs/plans/quality-engine.md):
-- a verdict, opening hours, or a one-line insider note. Append-only: a correction is a new
-- row, and readers take the latest of each group. Every row says where it came from (always
-- 'hand-verified'), who, and when.
--
-- Additive: pods from before this migration never touch it. It must be applied BEFORE the
-- new API pods start: today() reads it.
--
-- user_id goes NULL if the curator deletes their account: the fact is about the place.
CREATE TABLE place_facts (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  place_id   bigint      NOT NULL REFERENCES places (id) ON DELETE CASCADE,
  kind       text        NOT NULL CHECK (kind IN ('great', 'verified', 'closed', 'bad_fit', 'hours', 'note')),
  source     text        NOT NULL DEFAULT 'hand-verified' CHECK (source = 'hand-verified'),
  user_id    bigint               REFERENCES users (id) ON DELETE SET NULL,
  note       text,        -- kind 'note': one line; NULL clears the note
  hours_raw  text,        -- kind 'hours': the text as typed; NULL (with schedule) clears the hours
  schedule   jsonb,       -- kind 'hours': the normalized v1 schedule
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (note IS NULL OR (kind = 'note' AND char_length(note) BETWEEN 1 AND 140 AND note !~ E'[\n\r]')),
  CHECK (hours_raw IS NULL OR (kind = 'hours' AND char_length(hours_raw) <= 1024)),
  CHECK ((hours_raw IS NULL) = (schedule IS NULL))
);

CREATE INDEX place_facts_place ON place_facts (place_id, created_at DESC, id DESC);
CREATE INDEX place_facts_user ON place_facts (user_id);

-- The API records and reads facts, and never changes or removes one (docs/decisions/0003).
GRANT SELECT, INSERT ON place_facts TO larper_api;
