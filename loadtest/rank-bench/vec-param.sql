-- The user's taste vector as a parameter (the API already loads it in loadTaste())
-- instead of joining taste_profiles, which the planner re-probes once per place.
WITH o AS (SELECT ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography AS g)
SELECT p.id::text, p.name,
       ST_Y(p.geom::geometry) AS lat, ST_X(p.geom::geometry) AS lng,
       p.categories[array_length(p.categories, 1)] AS category, p.tags,
       coalesce(1 - (p.tag_vec <=> :vec), 0)::float8 AS taste,
       coalesce(c.locations, 1) AS "chainLocations",
       p.confidence::float8 AS confidence,
       ST_Distance(p.geom, o.g)::float8 AS "distanceM",
       p.website, p.instagram, p.phone
FROM places p
CROSS JOIN o
LEFT JOIN chain_stats c ON c.chain_key = p.chain_key
WHERE ST_DWithin(p.geom, o.g, :r)
ORDER BY taste DESC
LIMIT 3000
