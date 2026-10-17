# Ranking query bench: rank-bench-20261017-155149

200 pairs (cells from loadtest/results/cold-home-fix-20261017-150126/cells.json, 90 onboarded users, seed 0.42); equivalence on the first 40.
Postgres CPU = the pg container's cgroup usage over the run / 200 (includes parallel workers, planning, psql).

| variant | Postgres CPU per query (ms) | wall per query (ms) | planning p50 (ms) | execution p50 / p95 (ms) | same candidates |
|---|---|---|---|---|---|
| two-phase | 17.5 | 18.9 | 0.5 | 9.8 / 42.7 | yes (40 pairs) |
| chain-column | 18.2 | 19.5 | 0.5 | 9.3 / 43.4 | yes (40 pairs) |
