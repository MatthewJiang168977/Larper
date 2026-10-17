# Ranking query bench: rank-bench-20261017-145511

200 pairs (cells from loadtest/results/cold-home-final-20261017-135716/cells.json, 90 onboarded users, seed 0.42); equivalence on the first 40.
Postgres CPU = the pg container's cgroup usage over the run / 200 (includes parallel workers, planning, psql).

| variant | Postgres CPU per query (ms) | wall per query (ms) | planning p50 (ms) | execution p50 / p95 (ms) | same candidates |
|---|---|---|---|---|---|
| current | 57.3 | 31.1 | 2.0 | 18.3 / 72.5 | yes (40 pairs) |
| current-serial | 26.6 | 28.8 | 2.7 | 11.9 / 77.4 | yes (40 pairs) |
| vec-param-serial | 20.9 | 22.1 | 2.0 | 8.5 / 64.5 | yes (40 pairs) |
| two-phase | 18.8 | 19.7 | 0.5 | 10.0 / 45.4 | yes (40 pairs) |
| two-phase-sphere | 20.6 | 21.9 | 0.5 | 11.0 / 49.0 | NO (22 of 40 pairs differ) |
