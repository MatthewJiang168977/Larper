-- Contract step for 0008: nothing reads chain_stats any more (the API reads
-- places.chain_locations since 0008's release, and stats.Recompute stopped writing it
-- in this one). Recompute's per-chain advisory lock, not chain_stats' row locks, is what
-- keeps concurrent refreshes from overwriting each other's counts.
DROP TABLE chain_stats;
