# Ranking query bench: rank-bench-20261017-155038

200 pairs (cells from loadtest/results/cold-home-fix-20261017-150126/cells.json, 90 onboarded users, seed 0.42); equivalence on the first 40.
Postgres CPU = the pg container's cgroup usage over the run / 200 (includes parallel workers, planning, psql).

| variant | Postgres CPU per query (ms) | wall per query (ms) | planning p50 (ms) | execution p50 / p95 (ms) | same candidates |
|---|---|---|---|---|---|
| chain-column | 14.7 | 15.8 | 0.4 | 7.8 / 39.1 | yes (40 pairs) |
| two-phase | 18.6 | 19.9 | 0.5 | 10.7 / 45.4 | yes (40 pairs) |
