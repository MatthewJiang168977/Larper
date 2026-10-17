# Ranking query bench: rank-bench-20261017-152156

200 pairs (cells from loadtest/results/cold-home-fix-20261017-150126/cells.json, 90 onboarded users, seed 0.42); equivalence on the first 40.
Postgres CPU = the pg container's cgroup usage over the run / 200 (includes parallel workers, planning, psql).

| variant | Postgres CPU per query (ms) | wall per query (ms) | planning p50 (ms) | execution p50 / p95 (ms) | same candidates |
|---|---|---|---|---|---|
| current | 64.7 | 36.1 | 2.8 | 26.6 / 72.1 | yes (40 pairs) |
| current-serial | 27.3 | 28.1 | 2.6 | 11.2 / 77.9 | yes (40 pairs) |
| two-phase | 31.7 | 32.0 | 1.0 | 18.1 / 80.8 | yes (40 pairs) |
