# Ranking query bench: rank-bench-20261017-155013

200 pairs (cells from loadtest/results/cold-home-fix-20261017-150126/cells.json, 90 onboarded users, seed 0.42); equivalence on the first 40.
Postgres CPU = the pg container's cgroup usage over the run / 200 (includes parallel workers, planning, psql).

| variant | Postgres CPU per query (ms) | wall per query (ms) | planning p50 (ms) | execution p50 / p95 (ms) | same candidates |
|---|---|---|---|---|---|
| two-phase | 25.4 | 26.5 | 0.6 | 12.9 / 68.1 | yes (40 pairs) |
| chain-column | 20.6 | 21.2 | 0.5 | 10.6 / 53.9 | yes (40 pairs) |
