# Ranking query bench: rank-bench-20261017-152244

200 pairs (cells from loadtest/results/cold-home-fix-20261017-150126/cells.json, 90 onboarded users, seed 0.42); equivalence on the first 40.
Postgres CPU = the pg container's cgroup usage over the run / 200 (includes parallel workers, planning, psql).

| variant | Postgres CPU per query (ms) | wall per query (ms) | planning p50 (ms) | execution p50 / p95 (ms) | same candidates |
|---|---|---|---|---|---|
| current | 67.8 | 36.7 | 2.7 | 24.3 / 83.3 | yes (40 pairs) |
| current-serial | 25.2 | 26.5 | 2.6 | 11.7 / 75.1 | yes (40 pairs) |
| two-phase | 24.6 | 26.3 | 0.7 | 13.5 / 64.9 | yes (40 pairs) |
