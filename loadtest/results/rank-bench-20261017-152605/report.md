# Ranking query bench: rank-bench-20261017-152605

200 pairs (cells from loadtest/results/cold-home-fix-20261017-150126/cells.json, 90 onboarded users, seed 0.42); equivalence on the first 40.
Postgres CPU = the pg container's cgroup usage over the run / 200 (includes parallel workers, planning, psql).

| variant | Postgres CPU per query (ms) | wall per query (ms) | planning p50 (ms) | execution p50 / p95 (ms) | same candidates |
|---|---|---|---|---|---|
| current-serial | 17.8 | 19.0 | 1.8 | 7.9 / 59.7 | yes (40 pairs) |
| probe-notie | 17.1 | 18.7 | 0.5 | 10.1 / 39.3 | yes (40 pairs) |
| two-phase | 22.6 | 24.2 | 0.6 | 13.2 / 63.4 | yes (40 pairs) |
