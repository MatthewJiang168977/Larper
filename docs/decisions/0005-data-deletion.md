# 0005: Export and delete my data; what stays in backups

- **Status:** proposed, 2026-11-17 (the API half; the web screens are a separate PR)
- **Scope:** `db/migrations/0020_delete_my_data.*`, `apps/api/src/privacy/`,
  `apps/api/src/cache/cache.service.ts`, `workers/cmd/taste-worker`
- **Related:** `docs/plans/industry-ready-plan.md` (PR 3, D7), `0003-service-db-roles.md`,
  audit 2026-10 item 6

## Context

The journal is location history, and until now there was no way to get it out or to delete
it. The API's database role deliberately has no DELETE grant (0003), and `quests.origin`
kept the exact position of every offer forever.

## Decision

### Endpoints (all signed in, per-user limits, never take a user id from the request)

| Route | Does | Limit (per user) |
|---|---|---|
| `GET /me/export` | Everything held about the caller, as JSON, `Content-Disposition: attachment; filename="larper-export-YYYY-MM-DD.json"` (UTC date). | 3 a minute, 10 an hour |
| `DELETE /me/history` | Deletes the journal, check-ins, "was it open?" answers and saved places. Keeps the account and the taste profile. | 3 a minute, 10 an hour |
| `DELETE /me` | Deletes all of the above, the taste profile and the account row. | 3 a minute, 10 an hour |

`DELETE /me` uses a route-scoped hash of the verified Clerk subject for both rate
limit windows. The counters carry over if the Larper account row is recreated.

Both deletes answer 200 with the counts, and **403 `{"code":"demo_account"}` for the shared
demo account** (it is reset nightly by `ops/demo-reset.ts`; a visitor must not be able to
empty or remove it for the next one). `GET /me/export` refuses it the same way: the demo's
journal is every visitor's, with each offer's position, which can be a visitor's real
location. `DELETE /me` also says what happened to the Clerk
user: `"clerkUser": "manual" | "deleted" | "failed"`.

### How the API deletes without a DELETE grant

`SECURITY DEFINER` functions in migration 0020 follow `prune_checkin_attempts()` (0014).
The migration role owns them, pins `search_path` to `pg_catalog, public, pg_temp`, and
revokes access from `PUBLIC`. Only `larper_api` can execute the delete and export
functions. The API gets `users.id` from the verified session.

| Function | Deletes |
|---|---|
| `delete_my_history(user)` | `place_hours_facts` observations by the user; `saved_places`; `quests` (and, by cascade, their `checkin_attempts`); `outbox` rows keyed by the user id (sent or not). |
| `delete_my_account(user)` | `delete_my_history`, then `taste_profiles`, then the `users` row. |
| `export_my_checkin_attempts(user)` | Deletes nothing: a read of the user's check-in attempts, so the API gets no SELECT on that table (it still "writes attempts, never reads them"). |

`roles.db.spec.ts` checks the function grants. Observations are deleted before quests on
purpose: `place_hours_facts.quest_id` is `ON DELETE SET NULL`, which would leave the answer
behind. `place_hours_facts` schedule facts (`user_id` NULL) are places' data, not the user's.

After either delete the API drops the user's cached decks (`deck:*:<id>:*` in Redis).

### Races

Both deletes take `FOR UPDATE` on the user row before sweeping children. Quest actions
and hours answers take `FOR KEY SHARE` on the user and then the owned quest through
`lock_user_quest`, holding both locks through their writes. If a writer wins, the sweep
sees its committed children and events. If a delete wins, writes to its removed quests
return 404. A new offer's foreign key also needs a user key-share lock. It can proceed
after a history clear, and its foreign key fails if the account row was deleted. The
account delete holds its lock until after the outbox sweep and user removal commit.

### The exact offer position

`quests.origin` (where the user was when an offer was made) is now nullable and is set to NULL
as soon as the offer is resolved: when a quest is skipped, completed or expired (in the same
statement that does it), and by a sweep on API start and every six hours for the rest
(`SCRUB_ORIGINS_SQL`). Migration 0020 also clears every existing resolved quest; that backfill holds an ACCESS EXCLUSIVE lock on `quests` while it runs (it is the `ALTER TABLE`'s lock, held to the end of the migration's transaction; fine at today's size). It is only
needed while the offer is open (the 5 km stale-offer check), so open and accepted quests keep
it. Apply the migration before the new pods: they write NULL.

### Events already in flight

An event the relay already published can reach `taste-worker` after either delete. Before
locking the taste profile, the worker uses `lock_user_quest` to take the same user and quest
locks as the API. The function checks ownership and reads the quest after the user lock
is acquired. Missing users or quests cause the worker to skip the event. A taste update
that commits before a history clear remains in the retained profile. Only `larper_api`
and `larper_taste` can execute the locking function.

Apply migration 0020 before starting the API and taste worker that use this function.
Run the updated taste worker before making history deletion available so every consumer
checks quest ownership. `processed_events` keeps event IDs. The outbox sweep waits on rows
the relay has claimed with `FOR UPDATE SKIP LOCKED`. The ingest jobs are keyed by area.

### Deleting the Clerk user (D7): off by default

`CLERK_DELETE_USERS` (`1` or `true`; default unset = off). Off: `DELETE /me` removes Larper's
data and the owner removes the Clerk user by hand (Clerk dashboard), as D7 asked for. On:
after the database delete succeeds, the API calls `DELETE https://api.clerk.com/v1/users/<id>`
with `CLERK_SECRET_KEY`; a 404 counts as deleted; any other failure leaves the data deleted and
answers `"clerkUser": "failed"` (repeating `DELETE /me` retries Clerk). With it on and no
`CLERK_SECRET_KEY` the API refuses to start. The database goes first so a failure never leaves
data that its owner can no longer sign in to delete.

Not wired into Helm yet, on purpose: that is a live change and needs approval. To turn it on,
the API Deployment needs `CLERK_SECRET_KEY` (today only the demo's `larper.demoEnv` provides
it, and only when `demo.enabled`) and `CLERK_DELETE_USERS=1`, e.g. a `clerk.deleteUsers` value
rendering the second variable, plus the secret key from a Secret for the non-demo case. Note
that with it off, a user who deleted their account is still signed in at Clerk, and their
next API call creates a fresh empty account (`UsersService.ensure`); the web app should sign
them out after a delete.

## What happens to deleted data in backups

Copies of deleted rows can persist until the stores' normal cleanup runs.

- **Base backups and WAL.** CloudNativePG's Barman Cloud plugin uses a 14-day recovery
  window (`postgres.backup.retention: 14d` in `infra/helm/larper/values.yaml`). Full base
  backups are scheduled weekly at Sunday 03:00 and WAL is archived continuously.
  Recovery may need the last full backup before the window and the WAL from that backup
  onward. Backup eligibility therefore depends on successful backups and the window,
  and removal depends on when cleanup runs.
  [Barman Cloud retention policies](https://cloudnative-pg.io/plugin-barman-cloud/docs/next/retention/)
- **OCI lifecycle cleanup.** Objects in `larper-pg-backups` become eligible for cleanup
  at 60 days of object age under the documented lifecycle rule
  (`infra/oci-k3s/README.md`, "Backups"). This includes old server folders after a rebuild.
  Object removal depends on OCI lifecycle processing.
  [OCI lifecycle management](https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/usinglifecyclepolicies.htm)
- **Restore.** Restoring to a point before deletion can bring back the deleted rows.
  The current restore process has no deletion ledger to replay.
- **Redpanda segment retention.** The chart leaves `retention.ms` unset on `user.events`
  and `user.events.dlq` and sets no broker override. The documented Redpanda v24.2
  default for `log_retention_ms` is 604800000 ms (7 days). Cleanup applies to closed
  segments, so the time a record remains depends on segment rolling and background
  cleanup. These are chart and broker defaults. The running cluster was not checked.
  Quest records carry user, quest and place IDs. The dead-letter topic keeps a copy of
  records the consumer could not decode.
  [Redpanda v24.2 cluster properties](https://docs.redpanda.com/streaming/24.2/reference/properties/cluster-properties/)

The privacy page should say that deletion removes data from the live app and that
copies may persist in backups and event logs until scheduled cleanup.
