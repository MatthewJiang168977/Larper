# Ranking query bench: rank-bench-20261017-152922

200 pairs (cells from loadtest/results/cold-home-fix-20261017-150126/cells.json, 90 onboarded users, seed 0.42); equivalence on the first 40.
Postgres CPU = the pg container's cgroup usage over the run / 200 (includes parallel workers, planning, psql).

| variant | Postgres CPU per query (ms) | wall per query (ms) | planning p50 (ms) | execution p50 / p95 (ms) | same candidates |
|---|---|---|---|---|---|
| current-serial | 29.1 | 30.7 | 2.6 | 10.7 / 91.1 | yes (40 pairs) |
| probe-1p-tie | 23.6 | 24.9 | 2.0 | 10.2 / 71.8 | yes (40 pairs) |
| probe-2p-notie | 21.7 | 22.6 | 0.5 | 11.6 / 58.6 | yes (40 pairs) |
| two-phase | 18.9 | 20.1 | 0.5 | 10.2 / 49.4 | yes (40 pairs) |
