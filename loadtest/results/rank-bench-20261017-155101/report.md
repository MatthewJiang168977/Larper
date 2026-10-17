# Ranking query bench: rank-bench-20261017-155101

200 pairs (cells from loadtest/results/cold-home-fix-20261017-150126/cells.json, 90 onboarded users, seed 0.42); equivalence on the first 40.
Postgres CPU = the pg container's cgroup usage over the run / 200 (includes parallel workers, planning, psql).

| variant | Postgres CPU per query (ms) | wall per query (ms) | planning p50 (ms) | execution p50 / p95 (ms) | same candidates |
|---|---|---|---|---|---|
| two-phase | 21.0 | 22.7 | 0.5 | 12.0 / 52.0 | yes (40 pairs) |
| chain-column | 15.5 | 17.0 | 0.4 | 8.5 / 38.5 | yes (40 pairs) |
