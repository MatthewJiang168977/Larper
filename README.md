# Larper

Find the most niche thing to do near you, shown on a 3D map of your surroundings.

Larper hands you one **side quest** a day: the most unusual spot nearby that fits your taste. Think
hojicha soft serve in a mall basement, a photobooth bar, or the dumpling counter with no sign. You
accept it, walk there, and check in. Every choice you make feeds back into what it picks next.

It's also a systems project: a small but real distributed system (load-balanced API, cache, event
stream, idempotent workers, Kubernetes) built to be explained, measured, and broken on purpose.

---

## Tech stack

| Layer | Tech | Why |
|---|---|---|
| Web | **Next.js 16** (App Router), React 19, Tailwind 4, MagicUI, PWA manifest | Installable on a phone with browser geolocation; MagicUI used sparingly and re-themed |
| Map | **MapLibre GL 6** over **OpenFreeMap** vector tiles (OpenStreetMap) | Free and keyless, fully restylable (hand-written "field journal" style with 3D buildings) |
| Auth | **Clerk** (`@clerk/nextjs` 7) | Hosted sign-in; the API verifies Clerk JWTs itself against public keys (JWKS) |
| API | **NestJS 11** (TypeScript), `node-postgres`, `ioredis`, `jose` | Stateless, horizontally scaled behind the ingress |
| Workers | **Go 1.27**, `franz-go`, `pgx` | Small static binaries for Kafka consumers and batch jobs |
| Database | **PostgreSQL 17** + **PostGIS 3.6** + **pgvector 0.8**, run by **CloudNativePG** | Geo radius queries, vector similarity, and relational joins in one engine |
| Cache | **Redis 7.4** (LRU, 128 MB) | Cache-aside for area stats and per-user ranked decks |
| Event stream | **Redpanda 24.2** (Kafka API) | Ordered, replayable user events; keyed by user id |
| Work queue | Postgres `jobs` table with **Azure Service Bus semantics** (peek-lock leases, delivery count, dead-lettering) | One-off jobs like "load this area"; Service Bus can replace it in the cloud behind the same interface |
| Schemas | **Protobuf** with **buf**; generated for Go (`protoc-gen-go`) and TS (`protobuf-es`) | One contract for both languages, with lint and breaking-change rules |
| Place data | **Overture Maps** Places (CDLA-permissive), extracted with **DuckDB** (Python for bulk loads, the DuckDB CLI in the ingest-worker) | Open data that may be stored and indexed, unlike Google Places |
| Migrations | **golang-migrate**, run as a Helm hook Job | Same schema rollout locally and in the cloud |
| Platform | **Docker**, **Kubernetes** (k3d/k3s locally), **Helm**, **Traefik** ingress, HPA | One chart for local and cloud; Traefik is the load balancer |
| Planned | Azure Service Bus (cloud queue), AKS + Terraform, Prometheus/Grafana, k6 | See [roadmap](#status) |

---

## System design

### Architecture

```mermaid
flowchart LR
  subgraph client [Phone / browser]
    WEB["Next.js PWA<br/>MapLibre map"]
  end
  CLERK[("Clerk<br/>(identity, JWKS)")]

  subgraph k8s [Kubernetes cluster]
    ING["Traefik ingress<br/>(load balancer)"]
    API["NestJS API<br/>2-6 replicas (HPA)"]
    REDIS[("Redis")]
    PG[("Postgres 17<br/>PostGIS + pgvector<br/>CloudNativePG")]
    RELAY["outbox-relay<br/>(Go, 1 replica)"]
    KAFKA[["Redpanda<br/>user.events x6<br/>user.events.dlq"]]
    TASTE["taste-worker<br/>(Go, consumer group x2)"]
    INGEST["ingest-worker<br/>(Go + DuckDB, x2)"]
  end

  OVERTURE[("Overture Maps<br/>S3 GeoParquet")]
  TILES[("OpenFreeMap<br/>vector tiles")]

  WEB -->|"sign in"| CLERK
  WEB -->|"map tiles"| TILES
  WEB -->|"/api/* + Bearer JWT"| ING
  ING -->|"round-robin"| API
  API -.->|"verify JWT (cached JWKS)"| CLERK
  API -->|"cache-aside"| REDIS
  API -->|"quest UPDATE + outbox INSERT<br/>(one transaction)"| PG
  RELAY -->|"poll unsent<br/>FOR UPDATE SKIP LOCKED"| PG
  RELAY -->|"produce, key = user id"| KAFKA
  KAFKA -->|"consume"| TASTE
  TASTE -->|"taste vector + processed_events<br/>(one transaction)"| PG
  API -->|"enqueue ingest-area<br/>(unmapped area)"| PG
  INGEST -->|"lease job, load places,<br/>recompute stats"| PG
  OVERTURE -->|"S3 range reads"| INGEST
```

### Request path: `GET /quests/today?lat&lng`

1. **Ingress.** Traefik spreads requests across the API replicas. The HPA scales them from 2 to 6
   at 70% CPU. Pods drain for 5 s on shutdown (`preStop`), so rollouts drop no requests.
2. **Auth.** The guard verifies the Clerk session JWT: RS256 signature against the instance's JWKS
   (fetched once, then cached), issuer, expiry, and `azp`. The API holds **no Clerk secret**. The
   user row is created on first sight.
3. **Expire stale offers.** An offer older than 20 h, or more than 5 km from where it was made,
   becomes `expired`.
4. **Cache-aside.** The deck key is `deck:v3:{user}:{tasteVersion}:{geohash6}:{radius}`. Ranking
   runs from the **geohash6 cell center**, so a cached deck is exact for anyone in that cell.
   Because the key contains the taste profile's version, a taste update can never serve a stale
   deck, and nothing has to be deleted.
5. **On a miss, rank:**
   - PostGIS `ST_DWithin` on a GiST index finds candidates in the radius, and pgvector `<=>`
     computes taste similarity in the same query.
   - Area tag counts for the surrounding cells come from their own shared cache (1 h).
   - Candidates are scored in TypeScript, and the top 200 are cached for 10 min.
6. **Re-rank.** Places skipped or completed in the last 30 days are dropped. **MMR** (λ = 0.7,
   tag Jaccard) picks a deck of 10 that isn't all one kind of place.
7. **Offer.** The top pick is inserted as today's quest. A **partial unique index** (one
   `offered|accepted` quest per user) means two replicas racing to create one can't both succeed;
   the loser re-reads the winner's row.

### Event path: accept / skip / check in

1. **Transactional outbox.** The API updates the quest and inserts a protobuf `QuestEvent` into
   `outbox` **in one transaction**. The event exists if and only if the state change does; there
   is no dual write to the DB and Kafka. The `WHERE status = ANY(allowed)` clause enforces the
   state machine, so a double-click can't complete a skipped quest.
2. **Geofenced check-in.** `complete` requires a position within 75 m of the place, plus the
   phone's reported GPS accuracy (capped at 50 m). Otherwise it returns 422 and rolls back.
3. **Relay.** `outbox-relay` claims unsent rows `FOR UPDATE SKIP LOCKED`, produces them keyed by
   user id, and marks them sent **only after Kafka acks**. Delivery is at-least-once.
4. **Consume.** `taste-worker` replicas share the 6 partitions as a consumer group. Each event:
   - Inserts `event_id` into `processed_events` and applies the taste update **in the same
     transaction**. A redelivered event finds its id and is skipped (**idempotent consumer**).
   - Updates taste as an EWMA, `new = normalize((1-|b|)·old + b·place)`, with b = +0.20 for a
     check-in, +0.10 for accept and −0.05 for skip.
   - Commits Kafka offsets only after the DB commit, so a crash replays work instead of losing it.
   - Retries transient errors with backoff. Records it can't decode go to `user.events.dlq` with
     error and source-offset headers, so one bad record never blocks a partition.
5. **Feedback loop.** The taste update bumps `taste_profiles.updated_at`. The next
   `/quests/today` computes a new deck cache key and re-ranks with the new taste.

### Ingest path: opening the app somewhere new

1. **Survey.** `/quests/today` lists the geohash5 areas (~5 × 5 km) covering your radius. Any
   area missing from `areas_ingested` gets an `ingest-area` job. A partial unique index allows only
   one live job per area, so a crowd arriving in a new city still enqueues each area once.
2. **Respond without blocking.** The response carries `surveying: { pending, failed }`. While
   areas are pending, the API ranks **without caching** (a cached partial deck would hide the new
   places for its whole TTL) and **holds the quest** (a better spot may be on its way). The web app
   shows "Surveying the area…" and polls every 4 s.
3. **Lease.** An `ingest-worker` claims the job (`FOR UPDATE SKIP LOCKED`), taking a 2-minute
   **lease** that it renews while working, like Service Bus peek-lock and `RenewLock`.
4. **Load.** The worker runs DuckDB against Overture's GeoParquet on S3. The bbox columns let it
   read only the row groups that overlap the cell (a half-open box, so an edge place belongs to
   exactly one cell). Then the shared `places` pipeline tags, upserts and recomputes stats.
5. **Fail safely.**
   - A worker that dies mid-job stops renewing. Its lease lapses and another replica re-claims
     the job as the next attempt.
   - Every outcome write is **fenced on the attempt number**, so a zombie worker's late "done" is
     ignored.
   - Transient errors retry with exponential backoff (5 s, 10 s, 20 s…). After 5 attempts, or
     immediately for a malformed payload, the job is **dead**, the equivalent of a dead-letter queue.

### Niche scoring

```
score = (0.7·fit + 0.3·rarity) · (1 − 0.4·(1 − indie)) · (1 − 0.25·(1 − confidence)) · exp(−d / radius)
```

| Term | Meaning |
|---|---|
| `fit` | Taste cosine ÷ the best cosine among nearby candidates. Relative fit, so broad profiles still discriminate. |
| `rarity` | `log(N / n_tag) / log(N)` for the place's rarest tag, over the geohash6 cells around you |
| `indie` | `1 / (1 + ln(locations))`: 1 for a one-off, about 0.13 for a 900-location chain |
| `confidence` | Overture's confidence that the place exists as described |

Indie and confidence are **multipliers**, not added terms. They can demote a good match but never
create one. (The first version added them, which let any nearby one-off beat the best taste
match; there's a regression test for it.) Weights can be tuned with
`QUEST_WEIGHTS='{"taste":0.8}'`.

**Tags.** [`taxonomy.yaml`](workers/internal/taxonomy/taxonomy.yaml) maps Overture categories and
whole-word name keywords to **150 niche tags**. Each tag owns a fixed slot in a 160-dim vector.
Slots are append-only, so stored vectors never change meaning. Of 566k open NYC places, the
**80k** that match at least one tag are loaded.

### Data model

| Table | Purpose |
|---|---|
| `places` | Overture places: `geography(Point)` (GiST), `tag_vec vector(160)`, tags, chain key, contact links |
| `tags` | Slot → tag mapping, published by the loader so Go and TypeScript agree on the vector layout |
| `area_stats`, `area_totals` | Tag counts and place totals per geohash6 cell (rarity) |
| `chain_stats` | Locations per chain key (indie score) |
| `areas_ingested` | Which geohash5 areas have data |
| `users`, `taste_profiles` | Clerk id → user; `vec vector(160)` + `updated_at` (the cache version) |
| `quests` | The quest log; state enum, frozen reasons, offer origin; partial unique index |
| `outbox`, `processed_events` | Transactional outbox; per-consumer dedupe |
| `jobs` | Work queue: status, attempts, `locked_until` lease, backoff `run_after`, last error |

### Patterns, and where they live

| Pattern | Where |
|---|---|
| Load balancing + horizontal autoscaling | [`templates/api.yaml`](infra/helm/larper/templates/api.yaml) (Traefik ingress, HPA, topology spread) |
| Zero-downtime rollouts (readiness gating, `preStop` drain) | [`templates/api.yaml`](infra/helm/larper/templates/api.yaml) |
| Stateless JWT verification via JWKS | [`auth/clerk-verifier.ts`](apps/api/src/auth/clerk-verifier.ts) |
| Cache-aside, versioned keys, graceful Redis degradation | [`cache/cache.service.ts`](apps/api/src/cache/cache.service.ts), [`quests.service.ts`](apps/api/src/quests/quests.service.ts) |
| Geo indexing + vector similarity in one query | [`quests.service.ts`](apps/api/src/quests/quests.service.ts) `candidates()` |
| State machine enforced in SQL; race-safe "one active quest" | [`quests.service.ts`](apps/api/src/quests/quests.service.ts), [`0003_quests.up.sql`](db/migrations/0003_quests.up.sql) |
| Transactional outbox | [`events/outbox.ts`](apps/api/src/events/outbox.ts), [`cmd/outbox-relay`](workers/cmd/outbox-relay/main.go) |
| Idempotent consumer, manual offset commits, DLQ | [`cmd/taste-worker`](workers/cmd/taste-worker/main.go) |
| Partition key for per-entity ordering | outbox `key` = user id |
| Competing consumers, leases, fencing tokens, backoff, dead-lettering | [`internal/queue`](workers/internal/queue/queue.go), [`cmd/ingest-worker`](workers/cmd/ingest-worker/main.go) |
| Async request with a polling client (202-style "surveying") | [`areas.service.ts`](apps/api/src/quests/areas.service.ts), [`quest-home.tsx`](apps/web/components/quest/quest-home.tsx) |
| Shared schemas across languages | [`proto/`](proto/larper/events/v1/events.proto) |
| Schema migrations as a deploy hook | [`db/migrations`](db/migrations), [`templates/migrate.yaml`](infra/helm/larper/templates/migrate.yaml) |

### Trade-offs and decisions

- **Single outbox relay.** `SKIP LOCKED` would let several relays run without double-claiming
  rows, but two relays could publish one user's consecutive events in parallel and reorder them.
  One relay (with the `Recreate` strategy) keeps per-user order. Scaling past that would need
  partitioned claiming or leader election.
- **At-least-once over exactly-once.** It's simpler and robust; duplicates are absorbed by
  `processed_events`.
- **Geohash-cell ranking.** Ranking from the cell center gives exact cache hits for everyone in a
  ~1.2 × 0.6 km cell, at the cost of up to ~600 m of positional slack in the ordering. Distances
  shown to the user are still computed from their real position.
- **Cache keys instead of invalidation.** Folding the taste version into the key avoids a whole
  class of stale-cache bugs. Old keys simply expire.
- **Free map over Google 3D Tiles.** MapLibre + OpenStreetMap needs no billing account and can be
  fully styled. Renderers implement [`QuestMapProps`](apps/web/components/map/quest-map.ts), so
  Google Photorealistic 3D Tiles can replace it later. The cost: no opening hours or photos yet.
- **No Google Places storage.** Place data is Overture (storable). Google's terms forbid storing
  Places content, so it would only ever be fetched on demand.
- **Postgres queue locally, Service Bus in the cloud.** The jobs table copies Service Bus
  semantics, so the interface (`JobQueue` in TS, `queue.Queue` in Go) can switch transports
  without callers changing. Locally it saves running the Service Bus emulator and its SQL
  Server dependency (about 2 GB of RAM).
- **DuckDB CLI, not the Go binding.** The binding needs cgo. Shelling out keeps the Go binary
  static and runs the exact same SQL file as the Python bulk loader.
- **Lazy user creation.** Users are created on their first authenticated call. The Clerk webhook
  is deferred until it's needed (e.g. account deletion).

---

## Repo layout

```
apps/web/        Next.js PWA: map (components/map), quest sheet, onboarding, journal
apps/api/        NestJS API: auth, profile/onboarding, quests (scoring, cache, state machine), outbox
workers/         Go: cmd/{load-places, outbox-relay, taste-worker, ingest-worker}, internal/{places, queue, taxonomy, taste, stats, platform}
proto/           Protobuf event schemas (generated into workers/gen and apps/api/src/gen)
db/migrations/   SQL migrations (golang-migrate)
data/            Python bulk extract of Overture places (shares workers/internal/places/overture_extract.sql)
infra/           k3d cluster config, Helm chart, Postgres image (PostGIS + pgvector)
scripts/         up.sh / down.sh
```

---

## Running locally

### Prerequisites (Windows)
```powershell
winget install Docker.DockerDesktop   # restart afterwards, start Docker Desktop once
winget install k3d.k3d Helm.Helm Kubernetes.kubectl GoLang.Go
```

### Bring up the stack
```bash
pnpm install
./scripts/up.sh              # k3d cluster + Postgres/Redis/Redpanda + api + workers (Git Bash)
pnpm web:dev                 # web app on :3001, /api/* proxied to the cluster (:8080)
for i in 1 2 3 4; do curl -s localhost:8080/healthz; echo; done   # pod name changes = load balancing
./scripts/down.sh
```

### Load place data (NYC)
Migrations run automatically as a Helm post-install/upgrade Job.
```bash
pip install duckdb
python data/extract_overture.py --out data/nyc.parquet        # ~566k places, ~1 min, 27 MB
kubectl -n larper port-forward svc/pg-rw 55432:5432 &
PW=$(kubectl -n larper get secret pg-app -o jsonpath='{.data.password}' | base64 -d)
cd workers && DATABASE_URL="postgres://larper:$PW@127.0.0.1:55432/larper?sslmode=require" \
  go run ./cmd/load-places -in ../data/nyc.parquet           # ~80k quest-worthy places, idempotent
```

### Auth
Clerk handles sign-in in `apps/web` (keys in `apps/web/.env.local`, written by `clerk init`,
gitignored). The API only needs the public publishable key, set in `infra/helm/larper/values.yaml`.

### Useful commands
```bash
http://localhost:3001/?at=40.7295,-73.9965                              # fake your location (Washington Sq)
kubectl -n larper exec redpanda-0 -- rpk group describe taste-worker    # partitions, members, lag
kubectl -n larper logs -l app=taste-worker -f                           # applied / duplicate / dead-lettered
pnpm proto:gen                                                          # regenerate event types (needs buf)
kubectl -n larper logs -l app=ingest-worker -f                          # area ingests: leased, ingested, retries
TEST_DATABASE_URL=postgres://... go test ./internal/queue/              # queue integration tests (in workers/)
```

---

## Status

- [x] **1. Skeleton:** k3d cluster, 2 API replicas behind Traefik with an autoscaler, Postgres (PostGIS + pgvector), Redis, Redpanda.
- [x] **2. Data:** Overture extract (DuckDB), niche taxonomy + tag vectors, PostGIS load, area/chain stats.
- [x] **3. Auth + onboarding:** Clerk sign-in, JWKS-verified API guard, vibe-swipe onboarding seeding the taste vector.
- [x] **4. Scoring:** niche score + MMR, Redis cache-aside, quest state machine, zero-downtime rollouts.
- [x] **5. Map UI:** field-journal 3D map (MapLibre + OpenFreeMap), quest sheet, journal page, PWA manifest.
- [x] **6. Events:** transactional outbox, Go relay + idempotent taste-worker with DLQ, protobuf events, geofenced check-in.
- [x] **7. Async ingest:** unmapped area → leased work queue → ingest-worker (DuckDB) → stats refresh; "surveying the area…" in the app.
- [ ] **8. Deploy + prove it:** Terraform AKS, Prometheus/Grafana, k6 load test showing the HPA scale out.
