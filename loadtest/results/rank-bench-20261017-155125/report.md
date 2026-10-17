# Ranking query bench: rank-bench-20261017-155125

200 pairs (cells from loadtest/results/cold-home-fix-20261017-150126/cells.json, 90 onboarded users, seed 0.42); equivalence on the first 40.
Postgres CPU = the pg container's cgroup usage over the run / 200 (includes parallel workers, planning, psql).

| variant | Postgres CPU per query (ms) | wall per query (ms) | planning p50 (ms) | execution p50 / p95 (ms) | same candidates |
|---|---|---|---|---|---|
| chain-column | 19.8 | 20.8 | 0.4 | 11.0 / 57.3 | yes (40 pairs) |
| two-phase | 23.7 | 24.5 | 0.5 | 13.1 / 56.8 | yes (40 pairs) |
