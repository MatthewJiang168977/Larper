-- What QuestsService.candidates() runs: the two-phase query (archive/two-phase.sql)
-- with the chain size read from places.chain_locations (migration 0008) instead of a
-- chain_stats lookup per winner. The reference for rank-bench.sh.
-- setup:
SET max_parallel_workers_per_gather = 0
-- query:
WITH o AS (SELECT ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography AS g),
top AS (
  SELECT p.id, coalesce(1 - (p.tag_vec <=> t.vec), 0)::float8 AS taste
  FROM places p
  CROSS JOIN o
  LEFT JOIN taste_profiles t ON t.user_id = :uid
  WHERE ST_DWithin(p.geom, o.g, :r)
  ORDER BY taste DESC, p.id
  LIMIT 3000
)
SELECT p.id::text, p.name,
       ST_Y(p.geom::geometry) AS lat, ST_X(p.geom::geometry) AS lng,
       p.categories[array_length(p.categories, 1)] AS category, p.tags,
       top.taste,
       p.chain_locations AS "chainLocations",
       p.confidence::float8 AS confidence,
       ST_Distance(p.geom, o.g)::float8 AS "distanceM",
       p.website, p.instagram, p.phone
FROM top
JOIN places p ON p.id = top.id
CROSS JOIN o
ORDER BY top.taste DESC, top.id
