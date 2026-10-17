# Ranking query bench: rank-bench-20261017-145621

200 pairs (cells from loadtest/results/cold-home-final-20261017-135716/cells.json, 90 onboarded users, seed 0.42); equivalence on the first 40.
Postgres CPU = the pg container's cgroup usage over the run / 200 (includes parallel workers, planning, psql).

| variant | Postgres CPU per query (ms) | wall per query (ms) | planning p50 (ms) | execution p50 / p95 (ms) | same candidates |
|---|---|---|---|---|---|
| current | 46.5 | 25.7 | 1.8 | 16.7 / 56.4 | yes (40 pairs) |
| current-serial | 18.9 | 19.6 | 1.8 | 7.8 / 60.1 | yes (40 pairs) |
| vec-param-serial | 16.7 | 17.6 | 1.7 | 7.0 / 53.0 | yes (40 pairs) |
| two-phase | 17.8 | 19.6 | 0.5 | 9.9 / 41.4 | yes (40 pairs) |
| two-phase-sphere | 17.1 | 18.6 | 0.5 | 9.4 / 39.6 | NO (22 of 40 pairs differ) |
