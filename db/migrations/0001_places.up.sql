-- Place data (from Overture, CDLA-permissive: safe to store) and the stats that
-- the niche score reads. Extensions are created by CNPG at initdb as superuser.

CREATE TABLE places (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  overture_id  text        NOT NULL UNIQUE,
  name         text        NOT NULL,
  geom         geography(Point, 4326) NOT NULL,
  -- ~1.2 km x 0.6 km cell; the unit for rarity stats and cache keys.
  geohash6     text        GENERATED ALWAYS AS (ST_GeoHash(geom::geometry, 6)) STORED,
  categories   text[]      NOT NULL,          -- Overture taxonomy path, root first
  brand        text,
  chain_key    text        NOT NULL,          -- groups locations of the same business
  tags         text[]      NOT NULL,          -- human-readable niche tags
  tag_vec      vector(160) NOT NULL,          -- unit vector, one slot per tag
  confidence   real        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX places_geom_idx      ON places USING gist (geom);       -- ST_DWithin radius queries
CREATE INDEX places_geohash6_idx  ON places (geohash6);
CREATE INDEX places_chain_key_idx ON places (chain_key);
CREATE INDEX places_tags_idx      ON places USING gin (tags);

-- How many places carry each tag per geohash6 cell. rarity = log(total / count),
-- summed over a cell and its neighbours at query time.
CREATE TABLE area_stats (
  geohash6 text NOT NULL,
  tag      text NOT NULL,
  count    int  NOT NULL,
  PRIMARY KEY (geohash6, tag)
);

CREATE TABLE area_totals (
  geohash6   text        PRIMARY KEY,
  places     int         NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Number of locations per chain_key, for the indie score.
CREATE TABLE chain_stats (
  chain_key text PRIMARY KEY,
  locations int  NOT NULL
);

-- Which geohash5 areas have place data, so the API knows when to enqueue an ingest.
CREATE TABLE areas_ingested (
  geohash5       text        PRIMARY KEY,
  source_release text        NOT NULL,
  ingested_at    timestamptz NOT NULL DEFAULT now()
);
