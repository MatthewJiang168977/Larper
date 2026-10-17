-- What QuestsService.candidates() runs now: rank on the narrow columns first, then
-- fetch the wide ones (names, tags, links, distance, chain size) for the 3000 winners
-- only. No parallel workers (the API's pool turns them off).
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
  ORDER BY taste DESC
  LIMIT 3000
)
SELECT p.id::text, p.name,
       ST_Y(p.geom::geometry) AS lat, ST_X(p.geom::geometry) AS lng,
       p.categories[array_length(p.categories, 1)] AS category, p.tags,
       top.taste,
       coalesce(c.locations, 1) AS "chainLocations",
       p.confidence::float8 AS confidence,
       ST_Distance(p.geom, o.g)::float8 AS "distanceM",
       p.website, p.instagram, p.phone
FROM top
JOIN places p ON p.id = top.id
CROSS JOIN o
LEFT JOIN chain_stats c ON c.chain_key = p.chain_key
ORDER BY top.taste DESC
