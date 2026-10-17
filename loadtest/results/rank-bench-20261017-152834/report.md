# Ranking query bench: rank-bench-20261017-152834

200 pairs (cells from loadtest/results/cold-home-fix-20261017-150126/cells.json, 90 onboarded users, seed 0.42); equivalence on the first 40.
Postgres CPU = the pg container's cgroup usage over the run / 200 (includes parallel workers, planning, psql).

| variant | Postgres CPU per query (ms) | wall per query (ms) | planning p50 (ms) | execution p50 / p95 (ms) | same candidates |
|---|---|---|---|---|---|
| current-serial | 23.5 | 25.5 | 2.5 | 10.3 / 63.9 | yes (40 pairs) |
| probe-1p-tie | 21.5 | 22.4 | 1.7 | 9.1 / 71.2 | yes (40 pairs) |
| probe-2p-notie | 23.6 | 24.3 | 0.7 | 11.6 / 73.4 | yes (40 pairs) |
| two-phase | 19.8 | 20.8 | 0.5 | 11.9 / 47.9 | yes (40 pairs) |
