# Archived query variants

The variants measured while fixing the ranking query (PR #3) and moving the chain size
onto the place (PR #4). Their results are in `loadtest/results/rank-bench-*`.

They join `chain_stats`, which migration 0009 dropped, so they only run against a
database at schema version 8 or older. `current.sql` (the original query) is still
the reference for `apps/api/src/quests/candidates.db.spec.ts`, which swaps its
`chain_stats` join for a live count.
