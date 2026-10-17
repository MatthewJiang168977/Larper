# M9 plan: Profile & Taste Identity

Plan for the spec in [`M9-profile.md`](M9-profile.md), written 2026-10-17 against commit
`b843f4e`. Nothing here is built yet. File paths are real unless marked **new**. Decisions
that need the owner are collected under [Open questions](#open-questions-and-risks); where
the plan picks a default, it says so.

## What the codebase gives us

- **Events.** The API writes a protobuf `QuestEvent` (`event_id`, `user_id`, `quest_id`,
  `place_id`, `action`, `occurred_at`; `proto/larper/events/v1/events.proto`) to `outbox`
  in the same transaction as the quest update (`apps/api/src/quests/quests.service.ts`
  `act()`, `apps/api/src/events/outbox.ts`). `outbox-relay` publishes to `user.events`
  (6 partitions, keyed by user id) after commit and prunes sent rows after 7 days
  (`workers/cmd/outbox-relay/main.go:25, 64-69`). Only accept, skip and complete produce
  events; offers and expiries don't.
- **Consumer pattern.** `taste-worker` (`workers/cmd/taste-worker/main.go`): consumer group,
  manual commits after the DB commit, `processed_events (consumer, event_id)` insert in
  the same transaction as the effect, retry with backoff, poison records to
  `user.events.dlq`. The `processed_events` primary key is already `(consumer, event_id)`
  (`db/migrations/0005_events.up.sql`), so a second consumer needs no schema change for
  dedupe.
- **Quest facts.** `quests` keeps only the current `status` plus `created_at` and
  `updated_at` (`db/migrations/0003_quests.up.sql`). `completed` and `skipped` are
  terminal (`apps/api/src/quests/transitions.ts`), so a completed row's `updated_at` is
  its check-in time. But a skipped row doesn't say whether it was accepted first (skip is
  allowed from `offered` and `accepted`), and the offer-time rarity isn't stored: the
  score's rarity part exists in `Scored.parts.rarity` (`apps/api/src/quests/scoring.ts`)
  and only `score` and `reasons` (`liked`, `rarest: {tag, nearby}`, `indie`) are saved.
- **Tags.** 150 tags in `workers/internal/taxonomy/taxonomy.yaml`, grouped only by
  comment headers (sips & sweets, eats, drinks & nightlife, do something, dig through
  stuff, outside, body & mind, vibes). There is no machine-readable family. The API reads
  slot/tag from the `tags` table (`apps/api/src/profile/tags.service.ts`), which
  `places.syncTags` writes on every load (`workers/internal/places/places.go`).
- **Gaps that matter for M9.** Workers expose no metrics, and the only ServiceMonitor and
  dashboard are the API's (`infra/helm/larper/templates/monitoring.yaml`,
  `infra/helm/larper/dashboards/api.json`). The API has no rate limiting. The k6 scripts
  only call `GET /quests/today` (`loadtest/quests.js`), so no load test produces events.
  The web app isn't deployed by the chart (no template for it; it runs with `pnpm
  web:dev`), which matters for a public share URL.

## Redpanda retention: rebuild from Postgres

The topics Job creates `user.events` with partitions and replication only
(`infra/helm/larper/templates/workers.yaml:23-25`), so the topic uses the cluster
default retention. Redpanda's default `log_retention_ms` is 7 days; confirm with
`rpk cluster config get log_retention_ms` and `rpk topic describe user.events -c` the next
time a cluster is up (not run for this plan). Even with infinite retention, Kafka would
not be a complete history:

- Redpanda is one broker on a 2Gi PVC with no backup (`templates/redpanda.yaml`). Cloud
  clusters are destroyed after each demo, and the Oracle rebuild restores **Postgres only**
  (Barman, `templates/backup.yaml`).
- The outbox can't refill it either: sent rows are deleted after 7 days.

Postgres is the only durable, backed-up record of what users did, so the projection
must be **rebuildable from Postgres**. That also fixes the consumer design (next
section).

## Schema changes

All additive. Under the README's expand/contract rule (migrations run as a pre-upgrade
hook, `templates/migrate.yaml:14`, and must work for the pods still running), new
nullable columns and new tables are safe in one release: old pods never read or write
them. No contract step is needed in M9. Each migration gets a `.down.sql`.

| Migration (**new**) | Change | Why / rollout note |
|---|---|---|
| `0010_quest_facts` | `quests` add `accepted_at timestamptz`, `completed_at timestamptz`, `rarity real` (all nullable) | Makes the projection a function of stored facts. The new API sets them in `act()` and `offer()`. Rows written by old pods during the rollout, and all earlier rows, have NULLs; the projection reads `coalesce(completed_at, updated_at)` for completed rows (exact, since completed is terminal) and treats `status = 'completed'` as accepted (complete is only allowed from accepted). Legacy `rarity` stays NULL (see open question 6). |
| `0011_profile_stats` | `profile_stats (user_id PK → users ON DELETE CASCADE, checkins, neighborhoods, accepts, skips, streak_longest, streak_run, streak_last_day date, niche_score real, rarest_tag text, projection_version int, updated_at)`; index on `niche_score` | The consumer's projection. `streak_run`/`streak_last_day` let the API compute the *current* streak at read time (it decays without events). |
| `0012_tag_families` | `tags` add `family text` (nullable) | Hue per family for the palette. Old ingest-workers keep upserting `(slot, tag)` without it. |
| `0013_share_cards` | `share_cards (token_hash bytea PK, user_id → users ON DELETE CASCADE, payload jsonb, created_at, revoked_at)`; partial unique index on `user_id WHERE revoked_at IS NULL` | Only a SHA-256 of the token is stored, so a database leak doesn't expose live links. One active card per user (open question 4). |
| `0014_star_sign` (optional, last) | `users` add `birth_month smallint`, `birth_day smallint`, both nullable, with range checks | Opt-in only; month and day, never a year. |

If the audit's per-service database roles (`docs/audit-2026-10.md` item 3) land first,
each of these migrations also grants its tables to the roles that need them, and
profile-stats gets its own role (`profile_stats` read/write, `quests`, `places`,
`processed_events` read/insert).

## profile-stats consumer

**New** `workers/cmd/profile-stats/main.go`, consumer group `profile-stats` on
`user.events`, built into the existing workers image (`workers/Dockerfile`) and deployed
next to taste-worker in `templates/workers.yaml` (2 replicas sharing the 6 partitions).

**Design: per-user recompute, not deltas (recommended).** On each event, in one
transaction:

1. `INSERT INTO processed_events ('profile-stats', event_id) ON CONFLICT DO NOTHING`; if
   nothing was inserted, commit and report a duplicate (same as taste-worker).
2. `pg_advisory_xact_lock(<class>, user_id)`, the same two-int pattern as
   `stats.Recompute`'s per-chain lock (`workers/internal/stats/stats.go:12-46`), so the
   consumer and a concurrent rebuild serialize per user.
3. Recompute that user's row from `quests` joined to `places` and upsert
   `profile_stats`.

The recompute is **new** `workers/internal/profile` (`Recompute(ctx, tx, userID)`),
shared by the consumer and the rebuild command, so "rebuild gives identical stats" holds
by construction. Why not apply deltas from the event payload:

- Deltas double-count on bootstrap: a new group starts at the earliest retained offset
  (up to 7 days of events) on top of a rebuild that already counted them, and there is no
  clean watermark between a Postgres snapshot and a Kafka offset.
- A rebuild must equal the incremental result, and deltas depend on values that drift
  (area rarity changes when areas are re-ingested). Freezing rarity on the quest row and
  recomputing removes the drift.
- The relay publishes only after the quest transaction commits, so a recompute triggered
  by an event always sees at least that event's state.

The cost is a small aggregate per event (one user's quests, via `quests_user_recent`),
and the event payload is used only for `user_id`. The ADR has to say so honestly (see
open question 1).

**Projection** (definitions to confirm, open question 3):

| Field | Definition |
|---|---|
| check-ins | quests with `status = 'completed'` |
| distinct neighborhoods | distinct `left(places.geohash6, 5)` over check-ins (a geohash5 is about 5 × 5 km) |
| current / longest streak | consecutive local days with at least one check-in (gaps and islands over `coalesce(completed_at, updated_at)` in the user's time zone, open question 2) |
| niche score | mean of `quests.rarity` over check-ins with non-NULL rarity; NULL until there is one |
| percentile | computed at read time: share of users with ≥ N check-ins whose niche score is lower (indexed count on `profile_stats.niche_score`) |
| rarest category | `reasons->'rarest'->>'tag'` of the check-in with the highest `rarity` (ties: lower `nearby`, then tag name) |
| accept/skip ratio | accepts / (accepts + skips), accepts = `accepted_at IS NOT NULL OR status = 'completed'`, skips = `status = 'skipped'`; expired offers count as neither |

**Shared consumer loop.** taste-worker's poll/commit/retry/DLQ loop is ~100 lines. Extract
it into **new** `workers/internal/consumer` in its own commit before profile-stats uses
it, with taste-worker's behaviour unchanged. If the extraction stops being mechanical,
copy the loop instead and note the duplication.

**Rebuild.** `profile-stats rebuild [-user ID] [-compare]` (a subcommand of the same
binary): recompute every user (or one) under the same lock. `-compare` writes nothing and
prints rows whose stored projection differs from a fresh recompute; this is what the
chaos test and the "identical stats" test call. Run it once after the first deploy
(a value-gated Helm `post-install,post-upgrade` hook Job, or by hand; open question 8)
so users with no new events get a row. Bump `projection_version` when a definition
changes and rebuild.

**Lag metric and Grafana.** A consumer can't report its own lag while it's dead, which is
exactly what the chaos test needs to show. Preferred: Redpanda's own metrics on its admin
port (9644, not exposed by the chart today) scraped by a **new** ServiceMonitor, with
consumer-group metrics enabled in the cluster config. Whether v24.2.7 exposes lag
directly or only committed offsets needs checking (open question 7). Fallback: each
worker computes lag with franz-go's `kadm` every 15 s and exports
`larper_consumer_lag{group,partition}`, plus an "absent" panel for a dead consumer.
Either way: a metrics port in **new** `workers/internal/platform/metrics.go` (applied,
duplicate, dead-lettered counters), a ServiceMonitor for the workers in
`templates/monitoring.yaml`, and **new** `infra/helm/larper/dashboards/workers.json`
(lag per group, events/s by outcome, outbox unsent).

## Taste palette

- **Families.** Add `family:` to every tag in `taxonomy.yaml` (the eight existing section
  headers) and a top-level `families:` list with a fixed hue per family. Parse it in
  `workers/internal/taxonomy/taxonomy.go`; `syncTags` writes `tags.family`. Call
  `syncTags` at ingest-worker startup as well as per load, so a rollout fills the column
  without waiting for an ingest.
- **Function.** **New** `apps/api/src/profile/palette.ts`: taste vector → family weights
  (sum of positive slot weights per family) → top 3-5 families → colors (family hue;
  lightness and saturation from weight rank) and wave params (amplitude from the top
  weight, frequency from the number of significant families, phase from a hash of the
  rounded weights). No randomness and no `Date`, and weights are rounded before hashing
  so float noise can't change the output.
- **Where it runs.** The API computes the parameters; the browser only draws them (**new**
  `apps/web/components/profile/taste-palette.tsx`, SVG). This keeps one implementation and
  means the public share card never carries the raw 160-dim taste vector, which isn't on
  the spec's list of shareable aggregates.

## Taste archetypes

- **Offline k-means.** **New** `workers/cmd/archetypes`: builds synthetic taste vectors
  from the taxonomy (for each family and each pair of families, sample tag subsets with
  weights, normalize, add small noise; fixed seed), optionally adds real
  `taste_profiles.vec` rows with `-db`, runs k-means (k between 8 and 12, cosine distance,
  k-means++ with a fixed seed), and writes **new**
  `apps/api/src/profile/archetypes.json` (version, centroids, each centroid's top tags).
  Committed to the repo, so assignment is reviewable and reproducible.
- **Names.** **New** `apps/api/src/profile/archetype-names.ts`, a curated map from a
  centroid's top tags to a name. A test fails if any centroid in `archetypes.json` has no
  name, the same check `TagsService` does for vibe cards.
- **Online assignment.** In the API at read time: cosine to each centroid, nearest wins.
  It runs in the API rather than the consumer because the taste vector is written by
  taste-worker, a different consumer group with no ordering guarantee relative to
  profile-stats.
- **Cold start.** No archetype until accepts ≥ 5 (every check-in was an accept first, so
  this covers "check-ins/accepts"); the response says "still surveying your taste" with
  progress `n/5`.
- **Document** in the README that the clusters come from synthetic vectors because there
  are few real users, and how to re-run with `-db`.

## API

All in `apps/api/src/profile/` unless noted.

| Route | Guard | Returns |
|---|---|---|
| `GET /me/profile` | `ClerkAuthGuard` | stats (with current streak and percentile computed at read time), palette params, archetype or `{ surveying: true, progress }`, top tags (existing `topTags`), share status (`active`, no token) |
| `POST /me/share-card` | `ClerkAuthGuard` | `{ token, url }`. Builds a snapshot payload, stores it with `sha256(token)`, revokes any previous active card. Token: 32 bytes from `crypto.randomBytes`, base64url |
| `DELETE /me/share-card` | `ClerkAuthGuard` | 204; sets `revoked_at` |
| `GET /share/:token` | none; rate limited | the snapshot payload only. Unknown and revoked tokens give the same 404. `Cache-Control: no-store` so a revoke takes effect immediately |
| `PUT/DELETE /me/star-sign` (optional) | `ClerkAuthGuard` | opt-in birth month/day |

- **Payload whitelist.** **New** `share-card.ts` builds the public payload field by field
  (`palette`, `archetype`, `checkins`, `neighborhoods`, `longestStreak`, `percentile`,
  `rarestCategory`), never by spreading a row. No user id, no place names, no
  coordinates, no timestamps.
- **Snapshot, not live (recommended).** A live card would change when the user checks in,
  so anyone polling it could learn *when* they did, which is the timestamp the spec rules
  out. The owner re-shares to refresh (open question 4).
- **Rate limiting.** **New** `apps/api/src/common/rate-limit.guard.ts`: fixed window in
  Redis (`INCR` + `EXPIRE`, key per client IP and route), for example 60 requests a
  minute per IP, 429 with `Retry-After`. Redis is already shared by all replicas, so the
  limit holds across pods; a per-pod in-memory limit wouldn't. The client IP comes from
  `X-Forwarded-For` through Traefik, so Express needs `trust proxy` set to the ingress hop
  count (open question 9). A Traefik `RateLimit` middleware on `/share` could be added as
  a coarse outer limit. If Redis is down, fail open like `CacheService` does, or closed
  (open question 10).
- **Controllers.** `ProfileController` has a class-level guard, so the public route goes
  in a separate **new** `share.controller.ts`, registered in `apps/api/src/app.module.ts`.

## Web (apps/web)

- **New** `app/profile/page.tsx` (inside `RequireSignIn`): palette, archetype or "Still
  surveying your taste (3/5)", stats, and share controls: create (Web Share API, falling
  back to copy-to-clipboard), revoke with a confirmation, and a plain list of exactly
  what the card shows and never shows. Link it from the header in
  `components/quest/quest-home.tsx` next to Journal. Types in `lib/api.ts`.
- **New** `app/share/[token]/page.tsx`: public server component, fetching
  `${API_URL}/share/:token` server-side (the same `API_URL` `next.config.ts` already uses),
  rendering the card with a "Get your own" link. `generateMetadata` sets OG tags and
  `robots: noindex`; set `Referrer-Policy: no-referrer` so the token doesn't leak through
  outbound links. With `cacheComponents: true` the fetch must be uncached (revocation).
- **New** `app/share/[token]/opengraph-image.tsx`: `ImageResponse` from `next/og`
  drawing the same palette waves and aggregates. This is the "server-rendered OG image".
- Reuse the error and loading treatment from audit item 2 for both pages.

## Test plan

| Acceptance criterion | Test |
|---|---|
| Consumer idempotent (duplicate event) | **New** `workers/cmd/profile-stats/main_test.go` (DB-backed, `TEST_DATABASE_URL`, rolled back like `internal/stats/stats_test.go`): handle the same event twice → second is `duplicate`, `profile_stats` unchanged, one `processed_events` row. Also: two different events for one user processed concurrently → same result as serially (advisory lock). |
| Rebuildable, identical stats | **New** `workers/internal/profile/profile_test.go`: fixture users with completed, skipped-from-offered, skipped-after-accept, expired and legacy (NULL facts) quests; replay their events through the handler, then `rebuild -compare` → zero differences. Plus hand-computed expected values for each field, including streak edge cases (gap days, two check-ins in one day, a day boundary in a non-UTC zone). |
| Lag in Grafana | `helm template` renders the ServiceMonitor and dashboard ConfigMap with monitoring on; manual check on k3d that the lag panel rises while profile-stats is scaled to 0 and drains after. Screenshot into the results folder. |
| Chaos: kill consumer, no lost or double-counted stats | Extend `loadtest/chaos.sh`: kill a profile-stats pod (force and graceful) next to taste-worker at t=180, and at the end wait for lag 0 on both groups (`rpk group describe profile-stats`), then run `profile-stats rebuild -compare` and record the number of differing rows (must be 0). Needs a **new** k6 scenario that produces events: accept the offered quest, then complete it posting the place's own coordinates (passes the geofence), then fetch the next offer. Uses the existing load-test users (Clerk dev cap of 100). |
| Palette deterministic | **New** `apps/api/src/profile/palette.spec.ts`: same vector → deep-equal output across calls; a vector with tiny float noise → same output; 3-5 colors always; a family's hue never depends on other families; snapshot of a few fixed vectors. |
| Share-card payload has no place names, coordinates or timestamps | **New** `apps/api/src/profile/share-card.spec.ts`: build the payload from a fixture user whose places have distinctive names; assert its keys equal the whitelist exactly, that no string in it contains a fixture place name, and that no value matches a coordinate pattern, an ISO date or a user id. Controller test: unknown and revoked tokens both 404 with identical bodies; the 61st request in a window gets 429. |
| README M9 section + ADRs | Review: `docs/decisions/0002-profile-stats-consumer.md` and `docs/decisions/0003-aggregate-only-sharing.md` (**new**), README section and trade-offs entry. |

Also: migrations up/down on an empty database and on one with M8 data; archetype names
test; `buf breaking` unaffected (no proto change unless the "closed" action from audit
item 10 is added).

## Build order (one commit each)

1. **ADRs as drafts.** `docs/decisions/0002-profile-stats-consumer.md` (separate consumer
   vs computing in the API; per-user recompute; rebuild from Postgres and why) and
   `0003-aggregate-only-sharing.md` (snapshot payload, whitelist, hashed tokens). Locks
   the decisions before code; finalized in step 15.
2. **Quest facts.** Migration 0010; `act()` sets `accepted_at`/`completed_at`, `offer()`
   stores `rarity`; Jest for both.
3. **Extract the consumer loop** into `workers/internal/consumer`; taste-worker uses it,
   behaviour unchanged.
4. **Projection.** Migration 0011; `workers/internal/profile` with `Recompute` and the
   advisory lock; DB-backed tests with hand-computed values.
5. **profile-stats consumer.** `cmd/profile-stats` (consume, dedupe, DLQ), Deployment in
   `templates/workers.yaml`; duplicate-event test.
6. **Rebuild command** (`rebuild`, `-user`, `-compare`), optional hook Job; replay-vs-rebuild
   test.
7. **Worker metrics and lag.** `platform/metrics.go`, ServiceMonitor(s), `workers.json`
   dashboard.
8. **Tag families.** `taxonomy.yaml` families, parser, migration 0012, `syncTags` at
   ingest-worker startup; taxonomy tests.
9. **Palette.** `palette.ts` and its tests.
10. **Archetypes.** `cmd/archetypes`, committed `archetypes.json`, name map, nearest
    centroid and cold-start gating; tests.
11. **`GET /me/profile`** with read-time streak and percentile; tests.
12. **Share cards.** Migration 0013, `POST`/`DELETE /me/share-card`, `GET /share/:token`,
    rate-limit guard; payload whitelist and 404/429 tests.
13. **Web profile page** and header link.
14. **Web share page and OG image.**
15. **Chaos and docs.** k6 event scenario, `chaos.sh` changes, run it and commit the
    report under `loadtest/results/`; README M9 section, privacy trade-offs, Status line;
    finalize the ADRs.
16. **Optional: star sign.** Migration 0014, endpoint, UI toggle.

Steps 2-7 can ship before any UI, since nothing reads the new data yet. Every migration is
additive, so they can go out together or release by release.

## Open questions and risks

1. **Is a separate consumer justified?** With per-user recompute from Postgres, the API
   could compute the same stats on read at today's scale (one user's quests is a few
   dozen rows). The consumer keeps aggregation off the request path, keeps
   `profile_stats` warm for the percentile, and is the fan-out the spec wants to show.
   The ADR should state this trade-off rather than overstate the need.
2. **Time zone for streaks.** Nothing stores a user's time zone. Options: store an IANA
   zone from the browser on `users` (set by `/me/profile`), or use UTC (streaks break at
   7-8 pm in New York). Default in this plan: a stored zone, UTC until set.
3. **Definitions.** Streak unit (day vs week, given one quest a day); whether abandoning an
   accepted quest counts as a skip; minimum check-ins before a user enters the percentile
   population (proposed 3) and before a percentile is shown.
4. **Share card shape.** Snapshot (recommended, above) vs live. One active card per user
   vs several. Whether creating a new card should revoke the old link.
5. **Where the public page lives.** The chart deploys only the API; the web app runs
   locally, and Clerk's authorized parties are `http://localhost:3001`
   (`infra/helm/larper/values.yaml`). A shareable link needs the web app hosted somewhere
   public (a Deployment in the chart, or Vercel) with the share route reachable and
   `API_URL` set. This is outside M9's spec but blocks its demo.
6. **Legacy rarity.** Quests offered before 0010 have no stored rarity. Leave them out of
   the niche score (proposed), or backfill once from current `area_stats` and accept that
   those values aren't offer-time values.
7. **Lag source.** Check whether Redpanda v24.2.7's metrics include consumer-group lag or
   only committed offsets, and which cluster config enables them; otherwise use the kadm
   fallback.
8. **Initial rebuild.** A Helm hook Job on every upgrade (simple, idempotent, cost grows
   with users) vs a documented manual command.
9. **Client IP for rate limiting.** On EKS, Traefik sits behind an NLB; without proxy
   protocol or `externalTrafficPolicy: Local`, every request may appear to come from a
   node IP, so a per-IP limit would throttle everyone together. Needs a check on each
   target (k3d, EKS, Oracle k3s).
10. **Rate limiter when Redis is down.** Fail open (consistent with the cache) or closed
    (safer for a public route).
11. **Star sign semantics.** "Star sign from archetype" plus an optional birthday is
    ambiguous: a playful archetype-to-sign mapping, the real sign from month/day, or both.
    It's optional and last, so it can wait for a decision.
12. **Privacy edge.** A rarest category with `nearby = 1` ("the only ube spot around
    here") combined with a small neighborhood count could narrow down a place for someone
    who knows the city. Consider showing the rarest category only when its `nearby` is
    above a threshold.
13. **Account deletion.** `profile_stats` and `share_cards` cascade from `users`, but
    nothing deletes users yet (audit item 6). Revoking on account deletion depends on it.
