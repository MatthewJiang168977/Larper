-- Tag name for each vector slot. Written by load-places from taxonomy.yaml so the
-- API (TypeScript) and the workers (Go) agree on slots without sharing a file.
CREATE TABLE tags (
  slot int  PRIMARY KEY,
  tag  text NOT NULL UNIQUE
);

-- Created on a user's first authenticated API call (Clerk is the source of truth
-- for identity; we only keep the id we join on).
CREATE TABLE users (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clerk_id   text        NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE taste_profiles (
  user_id    bigint      PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  vec        vector(160) NOT NULL,     -- same slots as places.tag_vec
  source     text        NOT NULL,     -- 'onboarding' now; 'events' once the taste-worker runs
  updated_at timestamptz NOT NULL DEFAULT now()
);
