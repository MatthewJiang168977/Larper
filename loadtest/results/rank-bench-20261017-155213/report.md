# Ranking query bench: rank-bench-20261017-155213

200 pairs (cells from loadtest/results/cold-home-fix-20261017-150126/cells.json, 90 onboarded users, seed 0.42); equivalence on the first 40.
Postgres CPU = the pg container's cgroup usage over the run / 200 (includes parallel workers, planning, psql).

| variant | Postgres CPU per query (ms) | wall per query (ms) | planning p50 (ms) | execution p50 / p95 (ms) | same candidates |
|---|---|---|---|---|---|
| chain-column | 15.6 | 17.1 | 0.4 | 8.4 / 40.9 | yes (40 pairs) |
| two-phase | 24.6 | 25.6 | 0.6 | 13.0 / 64.7 | yes (40 pairs) |
