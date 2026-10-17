-- Locations per chain, stored on the place. The ranking query looked it up in
-- chain_stats for each of its 3000 candidates, ~5 ms of a cache miss
-- (loadtest/rank-bench.sh). stats.Recompute keeps it current. chain_stats stays until
-- every API pod reads this column; a later migration drops it.
ALTER TABLE places ADD COLUMN chain_locations int NOT NULL DEFAULT 1;

UPDATE places p SET chain_locations = c.n
FROM (SELECT chain_key, count(*)::int AS n FROM places GROUP BY 1 HAVING count(*) > 1) c
WHERE p.chain_key = c.chain_key;
