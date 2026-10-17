# Ranking query bench: rank-bench-20261017-152746

200 pairs (cells from loadtest/results/cold-home-fix-20261017-150126/cells.json, 90 onboarded users, seed 0.42); equivalence on the first 40.
Postgres CPU = the pg container's cgroup usage over the run / 200 (includes parallel workers, planning, psql).

| variant | Postgres CPU per query (ms) | wall per query (ms) | planning p50 (ms) | execution p50 / p95 (ms) | same candidates |
|---|---|---|---|---|---|
| current-serial | 36.3 | 36.7 | 4.0 | 15.1 / 108.9 | yes (40 pairs) |
| probe-1p-tie | 20.4 | 21.1 | 1.8 | 9.2 / 65.4 | yes (40 pairs) |
| probe-2p-notie | 18.1 | 18.9 | 0.5 | 9.7 / 42.1 | yes (40 pairs) |
| two-phase | 16.9 | 18.1 | 0.5 | 9.1 / 40.1 | yes (40 pairs) |
