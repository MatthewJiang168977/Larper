# Ranking query bench: rank-bench-20261017-152639

200 pairs (cells from loadtest/results/cold-home-fix-20261017-150126/cells.json, 90 onboarded users, seed 0.42); equivalence on the first 40.
Postgres CPU = the pg container's cgroup usage over the run / 200 (includes parallel workers, planning, psql).

| variant | Postgres CPU per query (ms) | wall per query (ms) | planning p50 (ms) | execution p50 / p95 (ms) | same candidates |
|---|---|---|---|---|---|
| current-serial | 18.7 | 19.9 | 1.8 | 8.0 / 60.8 | yes (40 pairs) |
| probe-notie | 19.0 | 20.0 | 0.5 | 11.1 / 45.1 | yes (40 pairs) |
| two-phase | 21.8 | 22.7 | 0.5 | 12.1 / 55.3 | yes (40 pairs) |
