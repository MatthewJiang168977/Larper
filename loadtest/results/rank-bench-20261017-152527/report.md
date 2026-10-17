# Ranking query bench: rank-bench-20261017-152527

200 pairs (cells from loadtest/results/cold-home-fix-20261017-150126/cells.json, 90 onboarded users, seed 0.42); equivalence on the first 40.
Postgres CPU = the pg container's cgroup usage over the run / 200 (includes parallel workers, planning, psql).

| variant | Postgres CPU per query (ms) | wall per query (ms) | planning p50 (ms) | execution p50 / p95 (ms) | same candidates |
|---|---|---|---|---|---|
| current-serial | 21.7 | 22.6 | 2.1 | 8.9 / 71.2 | yes (40 pairs) |
| probe-notie | 20.3 | 21.4 | 0.5 | 10.6 / 53.9 | yes (40 pairs) |
| two-phase | 24.0 | 25.5 | 0.6 | 14.8 / 51.1 | yes (40 pairs) |
