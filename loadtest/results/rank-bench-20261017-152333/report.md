# Ranking query bench: rank-bench-20261017-152333

200 pairs (cells from loadtest/results/cold-home-fix-20261017-150126/cells.json, 90 onboarded users, seed 0.42); equivalence on the first 40.
Postgres CPU = the pg container's cgroup usage over the run / 200 (includes parallel workers, planning, psql).

| variant | Postgres CPU per query (ms) | wall per query (ms) | planning p50 (ms) | execution p50 / p95 (ms) | same candidates |
|---|---|---|---|---|---|
| current | 63.5 | 35.0 | 2.8 | 24.2 / 69.8 | yes (40 pairs) |
| current-serial | 20.7 | 22.4 | 2.0 | 9.6 / 57.9 | yes (40 pairs) |
| two-phase | 29.7 | 31.1 | 0.9 | 17.0 / 69.2 | yes (40 pairs) |
