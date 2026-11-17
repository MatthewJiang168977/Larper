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

Both deletes answer 200 with the counts, and **403 `{"code":"demo_account"}` for the shared
demo account** (it is reset nightly by `ops/demo-reset.ts`; a visitor must not be able to
empty or remove it for the next one). `GET /me/export` refuses it the same way: the demo's
journal is every visitor's, with each offer's position, which can be a visitor's real
location. `DELETE /me` also says what happened to the Clerk
user: `"clerkUser": "manual" | "deleted" | "failed"`.

### How the API deletes without a DELETE grant

Three `SECURITY DEFINER` functions (migration 0020), like `prune_checkin_attempts()` (0014):
owned by the migration role, `SET search_path = pg_catalog, public, pg_temp`, `REVOKE ALL ...
FROM PUBLIC`, `GRANT EXECUTE ... TO larper_api` and no other role. Each takes our `users.id`,
which the API reads from the verified session.

| Function | Deletes |
|---|---|
| `delete_my_history(user)` | `place_hours_facts` observations by the user; `saved_places`; `quests` (and, by cascade, their `checkin_attempts`); `outbox` rows keyed by the user id (sent or not). |
| `delete_my_account(user)` | `delete_my_history`, then `taste_profiles`, then the `users` row. |
| `export_my_checkin_attempts(user)` | Deletes nothing: a read of the user's check-in attempts, so the API gets no SELECT on that table (it still "writes attempts, never reads them"). |

`roles.db.spec.ts` pins the four function grants. Observations are deleted before quests on
purpose: `place_hours_facts.quest_id` is `ON DELETE SET NULL`, which would leave the answer
behind. `place_hours_facts` schedule facts (`user_id` NULL) are places' data, not the user's.

After either delete the API drops the user's cached decks (`deck:*:<id>:*` in Redis).

### Races

A request running while `DELETE /me` executes may fail with a 500 (its user row vanishes
under it), and a quest created while `DELETE /me/history` runs may survive it. Repeating the
delete clears both.

### The exact offer position

`quests.origin` (where the user was when an offer was made) is now nullable and is set to NULL
as soon as the offer is resolved: when a quest is skipped, completed or expired (in the same
statement that does it), and by a sweep on API start and every six hours for the rest
(`SCRUB_ORIGINS_SQL`). Migration 0020 also clears every existing resolved quest; that backfill holds an ACCESS EXCLUSIVE lock on `quests` while it runs (it is the `ALTER TABLE`'s lock, held to the end of the migration's transaction; fine at today's size). It is only
needed while the offer is open (the 5 km stale-offer check), so open and accepted quests keep
it. Apply the migration before the new pods: they write NULL.

### Events already in flight

The outbox row of an event is deleted with the user, but an event the relay has already
published sits in Kafka and can reach `taste-worker` after the user is gone. The worker's
insert into `taste_profiles` then hits the foreign key to `users`; it used to retry that
forever (stalling the partition). It now recognises that error (SQLSTATE 23503 on
`taste_profiles`), rolls back and skips the event. `processed_events` holds only event ids
(no user id) and is left alone. `outbox-relay` and `ingest-worker` need nothing: the relay
claims rows with `FOR UPDATE SKIP LOCKED` (a delete waits for it), and jobs are keyed by area,
not by user. Redis holds only decks, which expire in 10 minutes and are dropped on delete.

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

Deleted rows are not removed from backups; they age out.

- **Base backups and WAL:** CloudNativePG's Barman Cloud plugin (`templates/backup.yaml`)
  gets `retentionPolicy` from `postgres.backup.retention`, which is `14d`
  (`infra/helm/larper/values.yaml`; the Oracle values don't override it). Base backups are
  weekly (`schedule: "0 0 3 * * 0"`, Sunday 03:00); WAL is archived continuously. Retention
  keeps the newest base backup that is older than now minus 14 days, and all WAL after it, so
  that any point in the last 14 days can be restored. A row deleted on day D can be in a base
  backup taken up to 7 days before D, and that backup must stay until it is no longer the
  newest one older than 14 days, which is about D + 21 days, plus the lag before the plugin's
  cleanup runs. So: **about 3 weeks**.
- **Backstop:** the bucket `larper-pg-backups` has a lifecycle rule deleting objects older than
  60 days (`infra/oci-k3s/README.md`, "Backups"), for what retention misses (an old server
  folder after a rebuild). So the hard upper bound for anything in the bucket is **60 days**.
- **No restore resurrects it unnoticed:** a restore replays the database as of its point in
  time, so a restore would bring deleted rows back. There is no deletion ledger to replay.
  After any restore, ask users who deleted since the restore point to delete again, or accept
  the gap; keeping a ledger of deleted user ids is possible but would itself be personal data
  (decision for the owner).
- **Kafka:** neither `user.events` nor `user.events.dlq` has a retention setting anywhere in
  the chart: `templates/workers.yaml` creates them with `rpk topic create <name> -p <n> -r 1`
  and no `-c`, and `templates/redpanda.yaml` (image `redpanda:v24.2.7`, `--mode=dev-container`)
  sets none. So the broker default applies: Redpanda's cluster property `log_retention_ms`,
  documented default 604800000 ms, **7 days** (Redpanda docs, cluster properties; not
  checked on the running cluster: `rpk topic describe user.events` shows it). Both topics
  hold user ids (the dead-letter queue keeps a copy of any record that could not be decoded),
  with quest and place ids, and no positions. They age out within 7 days.

The privacy page should say: deleted from the live app immediately; copies in
backups expire after about 3 weeks (60 days at most).
