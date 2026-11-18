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

All three routes use the same hash of the verified Clerk subject in both rate limit
windows. The rate limit key includes the route and window, so each counter is independent
and carries over if the Larper account row is recreated.

Both deletes answer 200 with the counts, and **403 `{"code":"demo_account"}` for the shared
demo account** (it is reset nightly by `ops/demo-reset.ts`; a visitor must not be able to
empty or remove it for the next one). `GET /me/export` refuses it the same way: the demo's
journal is every visitor's, with each offer's position, which can be a visitor's real
location. `DELETE /me` also says what happened to the Clerk
user: `"clerkUser": "deleted" | "failed"`.

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

Older API pods can take the locks in reverse order. Acceptance updates the quest before
the saved-place insert checks the user foreign key. The old hours-answer insert can also
take its quest foreign-key lock before its user lock. Either can deadlock with deletion
if the delete holds the user lock and is waiting for the quest.

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

`processed_events` keeps event IDs. The outbox sweep waits on rows the relay has claimed
with `FOR UPDATE SKIP LOCKED`. The ingest jobs are keyed by area.

### Rollout and rollback

The delete routes are gated by one API setting, `PRIVACY_DELETES`, read at startup. It is
`off` when unset or empty; `history` opens `DELETE /me/history`; `all` opens that and
`DELETE /me`. `all` also needs `CLERK_SECRET_KEY` (see D7). Any other value, or `all`
without the key, stops the API from starting. Off, both `DELETE /me/history` and `DELETE /me`
answer 503 `{"statusCode":503,"code":"deletes_unavailable","message":"deleting isn't available yet"}`
before any delete query, with no Retry-After header (the auth guard and the rate limits
still run first). The demo account still gets its 403. `GET /me`
reports what is on in `privacy: { export, deleteHistory, deleteAccount }`, and
`GET /me/export` is not affected by the setting. Nothing depends on the order of a
deploy: until the owner turns the setting on, the routes stay closed.

Owner steps:

1. Deploy with `PRIVACY_DELETES` unset. That applies migration 0020 and rolls out the new
   API and taste-worker.
2. Check that no old API or taste-worker pods remain
   (`kubectl -n larper get pods -o wide`, and the image tags), and that nothing is in
   flight. Old API pods take their locks in the reverse order, and the old worker stalls
   on a missing user.
3. Turn on `history` through a Helm value. That is a live change and needs the owner's
   approval. This PR does not add the Helm value. It would be an environment entry such
   as `PRIVACY_DELETES: history` in the API's environment in
   `infra/helm/larper/values.yaml`, applied with the usual deploy.
4. Turn on `all` the same way, after `history` has been checked. **Do not set it before
   the key is there:** `PRIVACY_DELETES=all` with no `CLERK_SECRET_KEY` makes the new API
   pods exit at startup and crash-loop. Today the key reaches the API pod only through
   `larper.demoEnv` when `demo.enabled`, and `scripts/oci-up.sh` turns demo off when
   `DEMO_USER_ID` is missing. So enabling `all` needs the key from a non-demo source
   first (a Helm change: a Secret reference in the API's environment independent of
   `demo.enabled`), then `all`. Both are live changes needing the owner's approval; this
   PR does not change Helm.
5. Rollback: set `PRIVACY_DELETES` back to off first (`history` if only `all` should
   go). Then roll the workers back to a build that skips missing users and quests. Only
   then consider reverting 0020.

`DELETE /me` stays off (503) until `all` is set.

The pre-PR taste worker treats a missing user's taste-profile foreign-key violation
(`23503`) as retryable, which can stall the consumer batch. A worker that handles only
that violation can still learn from a cleared quest for a retained user. Choose a rollback
target that skips events for missing users and quests and keeps the user-first lock order
while deletes can run. That event handling is still needed after disabling the routes,
because already-published records can be replayed after a rollback. Before reverting
migration 0020, move both services to compatible builds that work without its functions.

### Account deletion lifecycle (D7)

**Decided 2026-11-18 by the owner: a deleted user can sign up again as a brand-new
account. `DELETE /me` deletes our rows and the Clerk user. No tombstone: nothing about
the deleted user is kept.**

- **Order: our rows first, then Clerk.** The local purge commits, then the API calls the
  Clerk Backend API to delete the user. If Clerk fails, the user is still signed in and
  can repeat the request; the response is `"clerkUser": "failed"`. A Clerk user deleted
  first and then a failed local purge would leave data nobody could sign in to remove. A
  Clerk 404 counts as deleted.
- **Retry.** The repeat `DELETE /me` uses the same session. `ensure()` recreates an
  empty row for it, the repeat purges that row and retries Clerk.
- **Responses.** `{ "deleted": { ... }, "clerkUser": "deleted" }` or
  `{ "deleted": { ... }, "clerkUser": "failed" }`. There is no `"manual"` outcome and no
  `CLERK_DELETE_USERS` flag.
- **Sessions and the token window.** Deleting the Clerk user revokes its sessions. A
  session token already issued keeps verifying locally (the API checks the JWT without
  calling Clerk) until it expires. Clerk session tokens are short-lived, about 60 seconds
  by default; that is Clerk's setting, not ours. A request in that window would make
  `ensure()` insert a `users` row for the deleted Clerk id, which is a tombstone. So with
  `PRIVACY_DELETES=all`, `ensure()` confirms with the Clerk Backend API
  (`GET /v1/users/<id>`) before it inserts a new row: a 404 answers 401 and creates no
  row, and any other Clerk error answers 503 and creates no row. Existing rows never
  trigger the call, so only a brand-new user's first request pays it; concurrent first
  requests share one call. With `off` or `history` nothing changes (no call), and the
  demo user never triggers it. The window therefore ends in a 401, not a new row.
  One gap remains: a request that lands between the local purge committing and the Clerk
  deletion (milliseconds) still sees a live Clerk user and can insert a row that Clerk then
  removes. It is empty and holds only the Clerk id; it has no history, and a repeated
  `DELETE /me` removes it.
- **Signing up again.** The same email can sign up again. That is a fresh Clerk user with
  a new id, so it gets a new row and a new, empty account.
- **Nothing is kept to recognise them.** Nothing new that identifies the user is written
  at or after deletion: no table, column or log line is added for it. The Clerk and cache
  failure logs hold the HTTP status or error class at most, never a user or Clerk id. Rate
  limits are keyed by a hash that is not stored beyond its counter window, so a limit can
  carry over to a new account for a short time. Existing logs and events keep ids until
  their own retention runs out (see the end of the next section).
- **`CLERK_SECRET_KEY` must reach the API pod for `all`.** Today only the demo env
  provides it (`larper.demoEnv`, when `demo.enabled`). Enabling `all` therefore needs a
  Helm values change, which is a live change needing the owner's approval; this PR does
  not change Helm. The same key now also serves the new-account check above.

Suggested privacy wording: "Deleting your account removes your data from Larper and
deletes your sign-in. You can sign up again later with the same email as a new account.
Copies in backups expire on the schedule below." Do not promise removal by hand or within
a number of days.

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

- **API container logs on the VM.** Rotation is the kubelet's under k3s. `bootstrap.sh`
  installs k3s with no kubelet log flags, so the upstream defaults should apply: a
  container log rotates at 10Mi (`containerLogMaxSize`) and the last 5 files are kept
  (`containerLogMaxFiles`). Those are Kubernetes defaults and the running node was not
  checked, so this is unverified; how long that is in time depends on log volume. The API
  does not log request bodies or the user id on the delete path.
- **Sentry.** Events are kept per Sentry's plan retention, not verified. The SDK scrubs ids
  from events, transactions, spans and breadcrumbs (`apps/api/src/sentry/scrub.ts`).
- **Redpanda `user.events` and the dead-letter topic.** As above: the broker default of
  about 7 days.

When deletion is available, the privacy page should describe the local purge and how
copies may persist in backups and event logs until scheduled cleanup.
