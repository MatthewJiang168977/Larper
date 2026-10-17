# Ranking query bench: rank-bench-20261017-145717

200 pairs (cells from loadtest/results/cold-home-final-20261017-135716/cells.json, 90 onboarded users, seed 0.42); equivalence on the first 40.
Postgres CPU = the pg container's cgroup usage over the run / 200 (includes parallel workers, planning, psql).

| variant | Postgres CPU per query (ms) | wall per query (ms) | planning p50 (ms) | execution p50 / p95 (ms) | same candidates |
|---|---|---|---|---|---|
| current | 57.2 | 31.5 | 2.2 | 18.6 / 74.9 | yes (40 pairs) |
| current-serial | 21.3 | 22.3 | 2.1 | 9.5 / 66.0 | yes (40 pairs) |
| vec-param-serial | 30.8 | 31.3 | 3.0 | 12.4 / 92.5 | yes (40 pairs) |
| two-phase | 19.3 | 21.4 | 0.5 | 11.4 / 48.6 | yes (40 pairs) |
| two-phase-sphere | 16.0 | 18.0 | 0.5 | 8.9 / 37.4 | NO (22 of 40 pairs differ) |
