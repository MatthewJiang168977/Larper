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
| Work queue | Postgres `jobs` table (leases, delivery count, dead-lettering) locally; **Amazon SQS** delivers jobs in the cloud with the table kept as the ledger | One-off jobs like "load this area"; same interface either way (`QUEUE_BACKEND`) |
| Schemas | **Protobuf** with **buf**; generated for Go (`protoc-gen-go`) and TS (`protobuf-es`) | One contract for both languages, with lint and breaking-change rules |
| Place data | **Overture Maps** Places (CDLA-permissive), extracted with **DuckDB** (Python for bulk loads, the DuckDB CLI in the ingest-worker) | Open data that may be stored and indexed, unlike Google Places |
| Migrations | **golang-migrate**, run as a Helm hook Job | Same schema rollout locally and in the cloud |
| Platform | **Docker**, **Kubernetes** (k3d/k3s locally), **Helm**, **Traefik** ingress, HPA | One chart for local and cloud; Traefik is the load balancer |
| Cloud | **EKS** (1 Graviton node + **Karpenter**) + **ECR**, or **AKS** (Free tier) + **ACR**; **Terraform**; SQS on AWS | Brought up for a demo and destroyed after, so idle cost is $0 ([costs](#cloud-costs)) |
| Observability | **Prometheus + Grafana** (kube-prometheus-stack), `prom-client` in the API | Latency histograms per route, HPA replicas, CPU per pod on one dashboard |
| Load testing | **k6** with real Clerk session tokens | Exercises the full auth + ranking path, not a health check |

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
| Metrics: route-templated latency histogram, separate port | [`metrics/metrics.ts`](apps/api/src/metrics/metrics.ts), [`templates/monitoring.yaml`](infra/helm/larper/templates/monitoring.yaml) |
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
- **Postgres queue locally, SQS in the cloud.** The jobs table has queue semantics (leases,
  delivery count, dead-lettering), so the interface (`JobQueue` in TS, `queue.Queue` in Go) can
  switch transports without callers changing. In the cloud the table stays the ledger and an
  outbox (`dispatched_at`) hands jobs to SQS. SQS over Azure Service Bus because SQS has an
  always-free tier; only the ingest-worker talks to AWS, through an IAM user scoped to its queues.
- **Multi-arch images.** Every image is published for amd64 and arm64, so one tag runs on x86
  nodes (k3d, AKS, EKS) and ARM nodes (Oracle Ampere A1). Go and the API's TypeScript build
  cross-compile natively; only the PostGIS and DuckDB layers build under emulation.
- **Metrics on their own port.** `/metrics` listens on 9464, which the ingress never routes to,
  so latency and runtime internals aren't public. Prometheus scrapes each pod directly.
- **DuckDB CLI, not the Go binding.** The binding needs cgo. Shelling out keeps the Go binary
  static and runs the exact same SQL file as the Python bulk loader.
- **Lazy user creation.** Users are created on their first authenticated call. The Clerk webhook
  is deferred until it's needed (e.g. account deletion).
- **Karpenter over Cluster Autoscaler on EKS.** Cluster Autoscaler had no release for Kubernetes
  1.37 yet; Karpenter 1.15 supports it. Its NodePool is capped at one extra `t4g.large`
  (`limits.cpu: 2`) and removes the node 30 s after it empties, so a demo can't run up a bill.
- **EKS API reachable from one IP.** The public endpoint only accepts `api_allowed_cidrs` (no
  default, and `0.0.0.0/0` is rejected), set in a gitignored `terraform.tfvars`.
- **Monitoring has hard limits.** Grafana once crash-looped
  (OOM at 256Mi) and, with no CPU limit, burned ~9 cores per restart on the node running Postgres,
  which silently skewed two load tests. Monitoring now has hard CPU and memory limits.

---

## Repo layout

```
apps/web/        Next.js PWA: map (components/map), quest sheet, onboarding, journal
apps/api/        NestJS API: auth, profile/onboarding, quests (scoring, cache, state machine), outbox
workers/         Go: cmd/{load-places, outbox-relay, taste-worker, ingest-worker}, internal/{places, queue, taxonomy, taste, stats, platform}
proto/           Protobuf event schemas (generated into workers/gen and apps/api/src/gen)
db/migrations/   SQL migrations (golang-migrate)
data/            Python bulk extract of Overture places (shares workers/internal/places/overture_extract.sql)
infra/           k3d config, Helm chart (+ values-aks/eks.yaml), Postgres image, Terraform (azure, aws, eks), monitoring values
loadtest/        k6 script, failure test (chaos.sh), autoscaler runs (hpa-run.sh), cache + CPU profile (cache-profile.sh), reports in results/
docs/decisions/  Decision records (0001: sizing the API's CPU request and autoscaler)
scripts/         up.sh / down.sh (k3d), build-images.sh (amd64 + arm64), monitoring.sh, aks-up.sh, eks-up.sh / eks-down.sh
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

### Load test and monitoring
```bash
./scripts/monitoring.sh                         # Prometheus + Grafana; prints the Grafana port-forward and login
CLERK_SECRET_KEY=sk_test_... k6 run loadtest/quests.js      # 8 min ramp to 200 VUs (BASE_URL, USERS, PEAK_VUS)
kubectl -n larper get hpa api -w                # watch the autoscaler react
loadtest/hpa-run.sh <label>                     # k6 + autoscaler/CPU trace every 5 s -> results/hpa-<label>-*/report.md
SCENARIO=steps loadtest/hpa-run.sh sizing       # HPA off: 20..100 VUs, finds req/s per pod where p95 degrades
loadtest/chaos.sh                               # steady load while killing api, workers, Redis, Postgres in turn
loadtest/cache-profile.sh <label>               # cache hit rate + 60 s CPU profile (needs --set api.cpuProfiling=true)
```
The k6 script creates 10 `loadtest+N@example.com` users on the Clerk dev instance (once) and mints
their session tokens itself. The secret key stays on the machine running k6.

**Results on k3d** (laptop, k6 on the same machine, 2026-10-13):

| Run | Requests | Errors | Throughput | p50 / p95 | Replicas |
|---|---|---|---|---|---|
| 1 | 35,917 | **2.7%** (500s) | 78 req/s | 331 ms / 5.44 s | 2 → 6 in ~30 s |
| 2, after the fix | 50,243 | **0** | 108 req/s | 287 ms / 1.14 s | 2 → 6 in ~60 s |

- **The load test found a race.** Run 1's errors were all `offer vanished`: a request lost the
  "one active quest" insert to another replica, and a third request expired the winner's offer
  before the loser could read it. `offer()` now retries the free slot.
- **Then it was CPU-bound at the ceiling,** every pod pinned at its 500m limit. That turned out
  to be the CPU limit and a wrong-sized request, not a real ceiling (see autoscaler sizing below).

**Failure test:** 7 minutes of steady load (60 VUs) while `chaos.sh` kills one component a
minute. [First run](loadtest/results/chaos-20261013-121403/report.md), then the
[final run](loadtest/results/chaos-20261014-131859/report.md) with the Postgres fix, the final
autoscaler config and the profiling fixes.

| Killed | First run: failed / back after | Final run: failed / back after |
|---|---|---|
| API pod, force-killed | 0 / 8 s | 0 / 8 s |
| API pod, graceful delete | 0 / 11 s | 0 / 8 s |
| taste-worker, ingest-worker, outbox-relay | 0 / ≤ 1 s | 0 / 2–3 s |
| Redis | 0 / 4 s | 0 / 4 s |
| Postgres | **465** (503/502/500) over 11 s, **every API pod crashed** / 15 s | **143** (500) over 13 s, 0 API restarts / 13 s |

After the load stopped, Kafka consumer lag was 0 within 1 s and the outbox was drained, both
times. In the first run every API pod crashed when Postgres went away: `node-postgres` emits an
`error` event on idle clients when the server disappears, and nothing listened for it, so
Node treated it as an uncaught exception. The pool now logs it and times out connects after
5 s ([`db.module.ts`](apps/api/src/db/db.module.ts)). Now the API stays up and answers 500
until Postgres is back; a 503 with `Retry-After` would be more accurate. (An intermediate
[re-run](loadtest/results/chaos-20261013-230108/report.md) confirmed the fix but lost its
recovery times to a bug in the script's readiness check; see its `NOTE.md`.)

**Autoscaler sizing** ([decision record](docs/decisions/0001-hpa-cpu-request.md)). The HPA
targeted 70% of a 100m request, i.e. scale out at **70m per pod**, while a pod actually uses
~290m at a comfortable 9 req/s. So it went 2 → 4 replicas at just 20 VUs and spent all 6 replicas
on light load. A [sizing run](loadtest/results/hpa-sizing-20261013-211748/report.md) (HPA off,
2 pods, 20 → 100 VUs) measured the need, then four identical 8-minute ramps to 200 VUs compared
configs:

| Config | Throughput at 200 VUs | p95 at 200 VUs | p50 / p95 / p99 (whole run) | p95 < 800 ms |
|---|---|---|---|---|
| [Baseline](loadtest/results/hpa-before-ramp-20261013-212721/report.md): 100m request, 500m limit, 70% | 105 req/s | 3.25 s | 360 ms / 2.44 s / 4.96 s | fail |
| [(a)](loadtest/results/hpa-after-ramp-a-limit-20261013-215156/report.md): 300m request, 500m limit, 75% | 120 req/s | 2.62 s | 303 ms / 2.29 s / 4.07 s | fail |
| [(b)](loadtest/results/hpa-after-ramp-b-nolimit-20261013-223117/report.md): 300m request, **no CPU limit**, 75% | 156 req/s | 507 ms | 87 ms / 484 ms / 1.43 s | pass |
| [(c)](loadtest/results/hpa-after-ramp-c-fast60-20261013-224443/report.md): as (b), **60% target**, explicit fast scale-up | **183 req/s** | **164 ms** | **31 ms / 161 ms / 385 ms** | pass |

All four had 0 errors. Shipped (c):

- **Request = measured need (300m).** Fixing it alone (a) made the HPA scale for the right reason,
  but peak latency stayed bad: pods still sat at the 500m limit.
- **No CPU limit.** CFS quota pauses a pod for the rest of each 100 ms period once it uses its
  share, so a bursty Node.js process stalls every request in flight. Removing it (b) cut peak p95
  from 2.6 s to 0.5 s. The memory limit stays, and Postgres got requests (it was `BestEffort`)
  so unlimited API pods can't starve it.
- **60% target.** Metrics, the HPA loop and pod readiness add up to about a minute, and a ramp
  outruns that at 75%. (c) had 3 pods at 30 s and 6 by 90 s; ramp p95 stayed under 140 ms.
  The explicit scale-up policy is close to Kubernetes' default and isn't what made the
  difference. At the 200-VU plateau (b) and (c) are the same system, so that gap is laptop noise.
- **Cost on EKS:** at 300m only about one API pod fits next to the stack on the first node, so
  replica 2 starts Karpenter's node (≈ +$0.074/h). A 100m request would have packed six pods
  that need ~4 cores onto one 2-vCPU node.

**Cache hit rate and CPU profile** ([report](loadtest/results/profile-steady20-20261013-231701/report.md),
`loadtest/cache-profile.sh`): 20 VUs on 2 fixed pods (~9.6 req/s per pod, the sizing point), with
a `cache_lookups_total{cache,result}` counter and a 60 s V8 profile of one pod.

- **Deck cache: 98.9% hits over the run, ~100% once warm.** The test is cache-friendly (10 users
  near 8 fixed spots, decks live 10 minutes), so this is an upper bound. It does mean the CPU a pod
  used here was spent almost entirely on the **hit path**, not on PostGIS ranking.
- **Where a hit's CPU goes** (main thread ≈ 160m of the pod's ~215m; the rest is GC and libuv
  threads): garbage collection 25%, re-running MMR diversification over the 200 cached candidates
  on every request 20% (`jaccard` alone 12%), `JSON.parse` of that 200-candidate deck 8%, the
  `pg` driver 10%, Redis 4%, JWT verification 3%.
- **Debug logging was on in production:** Nest's default levels include `debug`, so every request
  wrote a coloured "hit deck:…" line to stdout, about 7% of the CPU (formatting plus `writev`).

**Fixed, and re-measured with the same harness**
([profile](loadtest/results/profile-steady20-optimized-20261014-130004/report.md),
[ramp](loadtest/results/hpa-after-ramp-c-optimized-20261014-130527/report.md)):

- **MMR without the quadratic re-check.** Each of the 10 picks re-computed every candidate's
  similarity to *all* earlier picks (~200 × 45 `jaccard` calls per request). Keeping each
  candidate's running maximum and updating it against only the newest pick gives the same deck
  with ~200 × 10 calls ([`scoring.ts`](apps/api/src/quests/scoring.ts); a test checks it picks
  exactly what the old version picks on 50 random 200-candidate pools).
- **No debug logs in the image** (`NODE_ENV=production`; `LOG_DEBUG=1` turns them back on).
- The candidate count stays at 200: cutting it would change which places users can be offered,
  and these two fixes don't.

| | Before | After |
|---|---|---|
| Main-thread CPU at 9.6 req/s per pod (profile) | ~159m | ~135m |
| Share of CPU in `scoring.js` | 19.5% | 4.8% |
| 200-VU ramp: CPU per req/s | 21.6m | 17.5m (−19%) |
| 200-VU ramp: p50 / p95 / p99 | 31 / 161 / 385 ms | 20 / 46 / 69 ms |
| 200-VU ramp: throughput at peak | 183 req/s | 195 req/s |

The 300m request stays: the drop is real, but at ~15–20% it's within the spread between sizing
runs, and over-reserving a little costs less than throttling would. GC (21%) and parsing the
cached deck (9%) are now the largest app-attributable costs.

---

## Cloud costs

### EKS (us-east-1)

Estimated from AWS on-demand list prices; not yet confirmed against a bill.

| Resource | Rate |
|---|---|
| EKS control plane (standard support) | $0.10/h |
| 1× t4g.large (Graviton, 2 vCPU / 8 GiB) | $0.067/h |
| Network load balancer (Traefik) | ~$0.029/h |
| 3 public IPv4 addresses | $0.015/h |
| EBS gp3 (root + PVCs) | ~$0.003/h |
| **Base** | **≈ $0.21/h** |
| + 1 Karpenter node at peak (instance, disk, IP) | +$0.074/h → ≈ $0.29/h |

- A 3-hour session with ~20 minutes at two nodes costs about **$0.67**.
- `scripts/eks-down.sh` uninstalls what Kubernetes created in AWS (NLB, EBS volumes, Karpenter
  nodes, launch templates, instance profile), waits for AWS to delete it, runs `terraform
  destroy`, then checks that nothing billable is left, including any EC2 instance in the region.
- The cluster version is pinned to one in standard support: extended support bills $0.60/h.

### AKS (eastus)

Prices from the Azure retail prices API (eastus, pay-as-you-go, 2026-10-13), paid from the Azure
for Students credit. The load balancer rate is from Azure's pricing page.

| Resource | Rate | Per month if left running |
|---|---|---|
| 1× Standard_B2as_v2 node | $0.0752/h | $54.90 |
| Standard load balancer (AKS outbound + Traefik) | $0.025/h | $18.25 |
| 2 public IPs (outbound, Traefik) | $0.005/h each | $7.30 |
| OS disk, P4 32 GB | | $5.28 |
| ACR Basic | $0.167/day | $5.07 |
| 2 PVC disks (Postgres, Redpanda), P1 4 GB | | $1.20 |
| AKS control plane (Free tier) | | $0 |
| Amazon SQS (always-free 1M requests/mo) | | $0 |
| **Total** | **≈ $0.13/h** | **≈ $92** |

- **Destroyed** (`terraform destroy` in `infra/terraform/azure`): $0. Only the budget alert in
  `azure/budget` remains, and it's free.
- **Stopped** (`az aks stop`) is not free: the load balancer, IPs, disks and registry keep billing
  (about $37/mo).
- A 2-hour demo costs under $1.

---

## Status

- [x] **1. Skeleton:** k3d cluster, 2 API replicas behind Traefik with an autoscaler, Postgres (PostGIS + pgvector), Redis, Redpanda.
- [x] **2. Data:** Overture extract (DuckDB), niche taxonomy + tag vectors, PostGIS load, area/chain stats.
- [x] **3. Auth + onboarding:** Clerk sign-in, JWKS-verified API guard, vibe-swipe onboarding seeding the taste vector.
- [x] **4. Scoring:** niche score + MMR, Redis cache-aside, quest state machine, zero-downtime rollouts.
- [x] **5. Map UI:** field-journal 3D map (MapLibre + OpenFreeMap), quest sheet, journal page, PWA manifest.
- [x] **6. Events:** transactional outbox, Go relay + idempotent taste-worker with DLQ, protobuf events, geofenced check-in.
- [x] **7. Async ingest:** unmapped area → leased work queue → ingest-worker (DuckDB) → stats refresh; "surveying the area…" in the app.
- [ ] **8. Deploy + prove it:** ~~Prometheus/Grafana~~, ~~k6 load test showing the HPA scale out (k3d)~~, ~~SQS queue~~, ~~failure test~~, ~~autoscaler sizing~~, Terraform EKS + Karpenter (written and planned, not yet applied), always-free k3s on Oracle Ampere A1 (waiting on capacity).
