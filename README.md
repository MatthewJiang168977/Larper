# Larper

[![CI](https://github.com/MatthewJiang168977/Larper/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/MatthewJiang168977/Larper/actions/workflows/ci.yml)

Find the most niche thing to do near you, shown on a 3D map of your surroundings.

Larper hands you one **side quest** a day: the most unusual spot nearby that fits your taste. Think
hojicha soft serve in a mall basement, a photobooth bar, or the dumpling counter with no sign. You
accept it, walk there, and check in. Every choice you make feeds back into what it picks next.

It's also a systems project: a small but real distributed system (load-balanced API, cache, event
stream, idempotent workers, Kubernetes) built to be explained, measured, and broken on purpose.

---

## Quick start

From a fresh clone to the app running on your machine. It was built on Windows 11; macOS and
Linux work the same without the Windows notes. The first run takes about 20 minutes (five
image builds and a one-minute data extract), and later runs a few.

### Prerequisites

| Tool | Version used | Install (Windows) |
|---|---|---|
| Docker Desktop (WSL 2 backend) | 29.8 | `winget install Docker.DockerDesktop`, then start it once |
| k3d (bundles k3s) | 5.9 (k3s 1.35.5) | `winget install k3d.k3d` |
| kubectl | 1.36 | `winget install Kubernetes.kubectl` |
| Helm | 4.3 | `winget install Helm.Helm` |
| Go | 1.27 (`workers/go.mod`) | `winget install GoLang.Go` |
| Node.js + pnpm | Node 22, pnpm 10.33.2 (`packageManager`) | `winget install OpenJS.NodeJS.LTS`, then `corepack enable` in an admin PowerShell (it writes next to `node.exe`), or `npm install -g pnpm@10.33.2` without admin |
| Python + DuckDB | 3.13, duckdb 1.5 | `winget install Python.Python.3.13`, then `pip install duckdb` |
| Git for Windows (Git Bash) | 2.46 | `winget install Git.Git` |

You also need a free [Clerk](https://clerk.com) account for sign-in, and about **10 GB of free
RAM**: the stack takes ~7.5 GB in Docker's VM.

### Windows notes

- **Git Bash for everything in this README**, including `./scripts/*.sh`. Use PowerShell only for
  `winget` and the admin fix below. Open a new Git Bash after installing so it picks up the PATH.
- **`MSYS_NO_PATHCONV=1`.** Git Bash rewrites arguments that look like Unix paths (`/readyz`,
  `/sys/fs/cgroup/cpu.stat`) into `C:/Program Files/Git/...` before Windows programs such as
  `kubectl` see them. Prefix those commands:
  `MSYS_NO_PATHCONV=1 kubectl -n larper exec pg-1 -c postgres -- cat /sys/fs/cgroup/cpu.stat`.
- **Reserved ports (winnat).** Windows reserves ranges of ports for Hyper-V/WinNAT, and the ranges
  move after a reboot. If the cluster's API port lands in one, `kubectl` fails with "No connection
  could be made because the target machine actively refused it". The cluster config pins the API
  to 6445 to make that rare. Check with `netsh interface ipv4 show excludedportrange protocol=tcp`.
  Fix it in an **admin PowerShell**, then start the cluster again:
  ```powershell
  net stop winnat; net start winnat
  ```
- **Without admin rights: a port proxy.** Leave the reserved port alone and reach the API server
  through a small container on the cluster's network, on a free port (6445 here, or any other):
  ```bash
  docker run -d --name k3d-larper-apiproxy --network k3d-larper -p 127.0.0.1:6445:6443 \
    alpine/socat tcp-listen:6443,fork,reuseaddr tcp-connect:k3d-larper-server-0:6443
  kubectl config set-cluster k3d-larper --server=https://127.0.0.1:6445
  kubectl get nodes          # 3 nodes, Ready
  ```
  It has to be recreated after each `k3d cluster start`; remove it with
  `docker rm -f k3d-larper-apiproxy`.

### Clerk dev keys

1. Sign up at [clerk.com](https://clerk.com) and create an application (email sign-in is
   enough). New applications start with a **Development** instance; that's the one to use.
2. In the dashboard, open **Configure → API keys** and copy the **Publishable key** (`pk_test_…`)
   and the **Secret key** (`sk_test_…`).
3. `cp apps/web/.env.example apps/web/.env.local` and paste both in. `.env.local` is gitignored.
   The web app uses both; `scripts/up.sh` passes only the publishable key to the API, which
   verifies tokens against your app's public keys and never holds the secret.

### Zero to running

```bash
git clone https://github.com/MatthewJiang168977/Larper.git && cd Larper
pnpm install                                     # ~2 min the first time
cp apps/web/.env.example apps/web/.env.local     # then paste your Clerk keys
./scripts/up.sh
```
`up.sh` creates the k3d cluster (1 server + 2 agents, a local registry on :5111, the ingress on
:8080), installs CloudNativePG, builds and pushes the five images, and installs the chart. It
ends with `Up. Try: for i in 1 2 3 4; do curl -s localhost:8080/healthz; echo; done`. Then:

```bash
kubectl -n larper get pods       # api x2, ingest-worker x2, outbox-relay, pg-1, redis, redpanda-0,
                                 # taste-worker x2: all Running
for i in 1 2 3 4; do curl -s localhost:8080/healthz; echo; done
# {"status":"ok","pod":"api-69586d44f5-fhz58"}    the pod name changes between requests
```

Load the NYC places (Overture data, read straight from its public S3 bucket):

```bash
python data/extract_overture.py --out data/nyc.parquet       # "wrote 566… places", ~1 min, ~35 MB
kubectl -n larper port-forward svc/pg-rw 55432:5432 &
PW=$(kubectl -n larper get secret pg-app -o jsonpath='{.data.password}' | base64 -d)
(cd workers && DATABASE_URL="postgres://larper:$PW@127.0.0.1:55432/larper?sslmode=require" \
  go run ./cmd/load-places -in ../data/nyc.parquet)          # ends "INFO done read=… kept=…" (~80k kept)
kill %1                                                      # stop the port-forward
```

Run the web app and open it:

```bash
pnpm web:dev       # Next.js on http://localhost:3001; /api/* goes to the cluster on :8080
```
Open <http://localhost:3001/?at=40.7295,-73.9965> (`?at=` fakes your location; this is
Washington Square). Sign up, swipe through the onboarding cards, and the map shows today's quest.

### Stop and clean up

| To | Run |
|---|---|
| Pause, keeping everything (data included) | `k3d cluster stop larper`; later `k3d cluster start larper` |
| Delete the cluster and its data (loaded places too) | `./scripts/down.sh` |
| Check for leftovers afterwards | `docker ps -a --filter name=larper` (e.g. `docker rm -f k3d-larper-apiproxy`) |

`pnpm web:dev` and port-forwards stop with Ctrl+C (or `kill %1` for a backgrounded one).

### Troubleshooting

- **A port is already in use.** The stack listens on 8080 (ingress), 5111 (registry), 6445 (k3d
  API) and 3001 (web); the data load forwards 55432. Find the owner in PowerShell:
  `Get-Process -Id (Get-NetTCPConnection -LocalPort 8080 -State Listen).OwningProcess`.
- **`kubectl` refuses to connect.** Check that `kubectl config current-context` says
  `k3d-larper` (`eks-up.sh` switches it to `larper-eks`), then see "Reserved ports" above.
- **Low memory.** With under ~10 GB free, Windows pages Docker's VM: everything slows down, load
  test numbers mean nothing, and pods can be OOM-killed. Check free RAM with
  `(Get-Counter '\Memory\Available MBytes').CounterSamples.CookedValue` and close what you can
  (browsers are the usual culprit). Docker's share is set in `%UserProfile%\.wslconfig`
  (`[wsl2]`, `memory=`). The monitoring stack (`scripts/monitoring.sh`) is optional and adds ~1 GB.
- **401 from the API after signing in.** The API has a different Clerk app's publishable key.
  Fill in `apps/web/.env.local` and run `./scripts/up.sh` again (`helm -n larper get values
  larper` shows what's set).
- **Clerk's 100-user cap.** Development instances stop at 100 users; creating one more fails with
  `403 user_quota_exceeded`. The load tests create up to 60 (`loadtest+0..9`,
  `loadtest-cold+0..49`). Delete users under **Users** in the dashboard.
- **Pods stuck after the laptop slept.** `k3d cluster stop larper && k3d cluster start larper`.
  A warning about `/etc/hosts` during the start is harmless if the nodes come up Ready.

The sections under [Running locally](#running-locally) have the day-to-day commands, load tests
and monitoring.

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
| `places` | Overture places: `geography(Point)` (GiST), `tag_vec vector(160)`, tags, chain key + `chain_locations` (indie score), contact links |
| `tags` | Slot → tag mapping, published by the loader so Go and TypeScript agree on the vector layout |
| `area_stats`, `area_totals` | Tag counts and place totals per geohash6 cell (rarity) |
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
  1.37 yet; Karpenter 1.15 supports it. Its NodePool is capped at two extra `t4g.large`
  (`limits.cpu: 4`) and removes a node 30 s after it empties, so a demo can't run up a bill.
  The idle stack (~2 CPU of requests) doesn't fit on one t4g.large, so one extra node is
  baseline and the second is scale-out headroom.
- **EKS API reachable from one IP.** The public endpoint only accepts `api_allowed_cidrs` (no
  default, and `0.0.0.0/0` is rejected), set in a gitignored `terraform.tfvars`.
- **Schema changes as expand/contract.** Migrations run before pods roll out (pre-upgrade hook),
  so each one has to work for the pods still running. Moving the chain size onto the place took
  two releases: 0008 added `places.chain_locations` while the stats refresh kept writing
  `chain_stats` for API pods that still read it, then 0009 dropped `chain_stats` once nothing
  read it. A grep of the repo (API, workers, tests, load tests, dashboards) found no other
  reader. The table's row locks had also been serializing concurrent stats refreshes by
  accident; an advisory lock took over that job first, so the drop is safe on its own
  (the concurrency test passes with only the lock). In the drop's release, old workers can
  still try to write the table for the few seconds of their rollout; their ingest job fails and
  retries (5 attempts, 5–40 s backoff), and the retry is idempotent. With live traffic we'd
  split this into two releases (stop writing, then drop); here there's no long-running
  deployment and the brief rollout window self-heals via ingest retries, so a single release
  is acceptable.
- **Test write paths at full size.** The lock bug above shipped with green tests: the stats
  tests inserted five places, so each refresh took a handful of locks, and the 200-pair
  equivalence test and the benchmark only ran read queries. The cost of a per-chain lock grows
  with the data, and the limit it hit (Postgres's shared lock table) is a fixed resource the
  small tests never got near. `TestRecomputeDenseArea` and `TestRecomputeAllAreas` now refresh
  Midtown and all of NYC against the real data, in a transaction they roll back, and assert the
  refresh holds at most one advisory lock.
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
infra/           k3d config, Helm chart (+ values-aks/eks/oci.yaml, values-demo.yaml for one small VM), Postgres image, Terraform (azure, aws, eks), oci-k3s (VM bootstrap + rebuild runbook), monitoring values
loadtest/        k6 script, end-to-end check (e2e-check.sh), footprint (footprint.sh), failure test (chaos.sh), autoscaler runs (hpa-run.sh), cache + CPU profile (cache-profile.sh), cache miss (cold-run.sh), output scrub (redact.js), reports in results/
docs/decisions/  Decision records (0001: sizing the API's CPU request and autoscaler)
scripts/         up.sh / down.sh (k3d), build-images.sh (amd64 + arm64), monitoring.sh, aks-up.sh, eks-up.sh / eks-down.sh, oci-capacity-probe.sh / oci-up.sh
```

---

## Running locally

First time? Start with the [Quick start](#quick-start): prerequisites, Clerk keys and Windows
notes are there.

### Bring up the stack
```bash
pnpm install
./scripts/up.sh              # k3d cluster + Postgres/Redis/Redpanda + api + workers (Git Bash)
pnpm web:dev                 # web app on :3001, /api/* proxied to the cluster (:8080)
for i in 1 2 3 4; do curl -s localhost:8080/healthz; echo; done   # pod name changes = load balancing
./scripts/down.sh
```

### Load place data (NYC)
Migrations run automatically as a Helm Job (pre-upgrade, or post-install on a fresh install).
```bash
pip install duckdb
python data/extract_overture.py --out data/nyc.parquet        # ~566k places, ~1 min, 27 MB
kubectl -n larper port-forward svc/pg-rw 55432:5432 &
PW=$(kubectl -n larper get secret pg-app -o jsonpath='{.data.password}' | base64 -d)
cd workers && DATABASE_URL="postgres://larper:$PW@127.0.0.1:55432/larper?sslmode=require" \
  go run ./cmd/load-places -in ../data/nyc.parquet           # ~80k quest-worthy places, idempotent
```

### Auth
Clerk handles sign-in in `apps/web` (keys in `apps/web/.env.local`, gitignored; template in
`apps/web/.env.example`). The API only needs the public publishable key: `scripts/up.sh` passes
yours from `.env.local`, and `infra/helm/larper/values.yaml` holds a default.

### Useful commands
```bash
http://localhost:3001/?at=40.7295,-73.9965                              # fake your location (Washington Sq)
kubectl -n larper exec redpanda-0 -- rpk group describe taste-worker    # partitions, members, lag
kubectl -n larper logs -l app=taste-worker -f                           # applied / duplicate / dead-lettered
pnpm proto:gen                                                          # regenerate event types (needs buf)
kubectl -n larper logs -l app=ingest-worker -f                          # area ingests: leased, ingested, retries
TEST_DATABASE_URL=postgres://... go test ./internal/queue/              # queue integration tests (in workers/)
TEST_DATABASE_URL=postgres://... go test ./internal/stats/              # stats refresh vs the stack's Postgres, incl. Midtown + all NYC at full size; rolled back
TEST_DATABASE_URL=postgres://... pnpm --filter @larper/api test candidates.db  # ranking query vs the old one on real data (pg port-forward; TEST_NYC_DATA=0 skips the 200-pair checks)
```

### CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every pull request and push to
`main`, in four parallel jobs (each capped at 10 minutes, no secrets, nothing deployed):

| Job | What it checks |
|---|---|
| API | `pnpm install` (cached), `tsc --noEmit`, ESLint (`apps/api/eslint.config.mjs`), Jest unit tests |
| Go workers | `gofmt -l`, `go vet ./...`, `go test ./...` (unit tests; the integration tests skip) |
| Database | Postgres 17 + PostGIS 3.6 + pgvector 0.8 as a service container, all migrations applied with the Helm Job's `migrate` image, then the Go integration tests (queue, stats refresh, the lost-update race) and the API's `candidates.db` spec |
| Helm | `helm lint`, and the chart rendered with the default, monitoring, AKS, EKS and OCI values |
| Secret scan | gitleaks (pinned image) over **every commit**, default rules plus [`.gitleaks.toml`](.gitleaks.toml), which allows only Clerk publishable keys (public by design). Before a commit: `scripts/secret-scan.sh` (staged changes) or `--history` (what CI runs) |
| Load-test results | `loadtest/redact.js --check`: no Clerk session IDs, tokens or k6 `setup_data` in `loadtest/results` |

The database is empty apart from what the tests insert, so two kinds of test skip there and run
locally against the stack: the Midtown / all-NYC stats refreshes (they skip without the NYC
places) and the 200-pair ranking-equivalence checks (`TEST_NYC_DATA=0`). The OCI capacity probe
is a separate workflow that only runs on its schedule.

### Load test and monitoring
```bash
./scripts/monitoring.sh                         # Prometheus + Grafana; prints the Grafana port-forward and login
CLERK_SECRET_KEY=sk_test_... k6 run loadtest/quests.js      # 8 min ramp to 200 VUs (BASE_URL, USERS, PEAK_VUS)
kubectl -n larper get hpa api -w                # watch the autoscaler react
loadtest/hpa-run.sh <label>                     # k6 + autoscaler/CPU trace every 5 s -> results/hpa-<label>-*/report.md
SCENARIO=steps loadtest/hpa-run.sh sizing       # HPA off: 20..100 VUs, finds req/s per pod where p95 degrades
loadtest/chaos.sh                               # steady load while killing api, workers, Redis, Postgres in turn
loadtest/cache-profile.sh <label>               # cache hit rate + 60 s CPU profile (needs --set api.cpuProfiling=true)
loadtest/cold-run.sh <label>                    # cache miss: Redis flushed, fresh cells per user (COLD_MODE=relocate adds offer churn)
```
The k6 script creates 10 `loadtest+N@example.com` users on the Clerk dev instance (once) and mints
their session tokens itself; the cache-miss test uses its own 50 onboarded `loadtest-cold+N`
users (a Clerk dev instance stops at 100). The secret key stays on the machine running k6.
Sessions don't outlive the run: `quests.js` revokes them in `teardown()`, and every script
runs its output through [`loadtest/redact.js`](loadtest/redact.js) on exit, which drops k6's
`setup_data` (the session IDs) from `summary.json` and replaces anything shaped like a Clerk ID,
JWT or secret key. Run it yourself after a bare `k6 run --summary-export`
(`node loadtest/redact.js <file>`); CI fails if a committed result still has one.

**Results at a glance** (milestone 8). Details and reports for each are below.

| Test | Where | Result |
|---|---|---|
| Scale-out ramp to 200 VUs, warm cache | k3d | 195 req/s, p50 / p95 / p99 21 / 47 / 73 ms, 0 errors, 2 → 6 API replicas |
| Same ramp, warm cache | **EKS** (1 Graviton node + Karpenter) | 186 req/s, p50 / p95 42 / 187 ms from the laptop to us-east-1, 0 errors, 2 → 6 replicas on the managed node + one Karpenter node |
| Cache miss, 100 VUs, Redis flushed | k3d | deck hits 0.1%, p50 / p95 / p99 59 / 151 / 217 ms, 0 errors; Postgres ~2.9 cores at 93 req/s after the [ranking-query fix](#ranking-query-fix) (it was the bottleneck at ~5 cores) |
| Failure test: kill API, workers, Redis, Postgres under load | k3d | 0 errors for everything but Postgres; Postgres down 13 s = 143 errors, no API crash (it used to take every API pod down) |
| Autoscaler sizing | k3d | 300m request, no CPU limit, 60% target ([ADR](docs/decisions/0001-hpa-cpu-request.md)): peak p95 3.25 s → 0.16 s |
| Oracle k3s rebuild: bootstrap, reboot, k3s restart under load, restore from backup | local stand-in VM | all checks pass ([details](infra/oci-k3s/README.md#local-rehearsal)) |

- **Verified:** everything in the table. EKS was created with Terraform, load tested, and
  destroyed with `eks-down.sh`, which confirmed nothing billable was left. The run found two
  EKS-only bugs (Redpanda couldn't write to a root-owned EBS volume; the idle stack's CPU
  requests didn't fit one `t4g.large`, so Karpenter got room for two extra nodes).
- **Pending Oracle capacity:** the always-free A1 VM. Its bootstrap, firewall, backups and
  restore are rehearsed on the stand-in; what's left is anything only the real VM has (arm64
  images in place, Oracle's S3 endpoint, the VCN). A probe asks for capacity every 10 minutes,
  for 1 OCPU / 6 GB running the [demo profile](#demo-profile-one-small-vm).
- **Optional, not run:** the failure test on EKS. The k3d run covers the app's behaviour when
  each component dies; on EKS it would add the managed pieces (EBS reattach, NLB). An attempt
  was cut short by tearing the cluster down mid-run, so there are no EKS chaos numbers.
- **Not applied:** AKS. Its Terraform is validated and kept as a second target for the same
  chart.

**Results on k3d, warm cache** (laptop, k6 on the same machine, 2026-10-13). 10 users near
8 fixed spots, so nearly every request is a deck-cache hit (98.9% measured below); see
[cache miss](#cache-miss) for the other end:

| Run | Requests | Errors | Throughput | p50 / p95 | Replicas |
|---|---|---|---|---|---|
| 1 | 35,917 | **2.7%** (500s) | 78 req/s | 331 ms / 5.44 s | 2 → 6 in ~30 s |
| 2, after the fix | 50,243 | **0** | 108 req/s | 287 ms / 1.14 s | 2 → 6 in ~60 s |
| [EKS](loadtest/results/hpa-eks-20261017-000510/report.md), final config (2026-10-17) | 65,715 | **0** | 186 req/s | 42 ms / 187 ms | 2 → 6 in ~120 s |

On EKS k6 ran from the laptop, so latency includes the trip to us-east-1. All 6 API replicas
fit on the managed node plus the one baseline Karpenter node; the second extra node wasn't needed.

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

All warm cache:

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

#### Cache miss

Every number above is the **warm-cache** case. `loadtest/cold-run.sh` measures the other end:
Redis flushed right before k6, onboarded users (so ranking computes real taste similarity),
and every request in a cell the user hasn't asked about yet, ramping to 100 VUs and holding
3 minutes on the final config (2026-10-17, k3d). Only cells whose whole search area is
already ingested are used: no request started an ingest job. These runs are from before the
[ranking-query fix](#ranking-query-fix); the after numbers are there.

- **Cache miss** (`COLD_MODE=home`): each user has a home cell, and their requests visit
  every populated cell within 4.9 km of it once. Offers expire at 5 km, so the user's offer
  stays put and the only extra writes are re-onboards that give a user fresh cache keys
  for another lap (403, ~2% of requests). 50 users with 2 VUs each, because a Clerk dev
  instance stops at 100 users.
- **Cache miss + offer churn** (`COLD_MODE=relocate`): users jump to a random cell anywhere
  in the city on every request, so each request also expires the last offer and inserts a
  new one (18,879 offers expired in the run).

| | Warm cache ([200-VU ramp](loadtest/results/hpa-after-ramp-c-optimized-20261014-130527/report.md)) | [Cache miss](loadtest/results/cold-home-final-20261017-135716/report.md) | [Cache miss + offer churn](loadtest/results/cold-relocate-final-20261017-140429/report.md) |
|---|---|---|---|
| Deck cache hit rate | ~99% | **0.1%** | 2.6% |
| Area-stats cache hit rate (shared per cell) | ~100% | 93.9% | 71.3% |
| Throughput at the plateau | 195 req/s (200 VUs) | 92 req/s (100 VUs) | 93 req/s (100 VUs) |
| p50 / p95 / p99 | 21 / 47 / 73 ms | **70 / 178 / 267 ms** | 52 / 146 / 208 ms |
| API CPU per req/s | 17.5m | **44m** | 34m |
| Postgres CPU | ~1.0 core | **~5.1 cores** (~55m per req/s) | ~3.7 cores (~39m per req/s) |
| API replicas | 6 | 2 → 6 in ~60 s | 6 (still up from the previous run) |
| Errors | 0 | 0 | 0 |

- **Postgres is the bottleneck on misses.** At 92 req/s it burned ~5 of the laptop's 20 cores,
  more than all six API pods together (~4 cores), and it is the one piece the autoscaler can't
  add copies of. The API scaled out as designed; each miss costs it 2.5× a hit (the ranking
  itself, plus parsing 3,000 candidate rows instead of a cached deck).
- **Neither was saturated.** 100 VUs with ~1 s of think time can't ask for more than ~93
  req/s, the laptop had half its cores free, and p95 stayed under 200 ms. The ceiling for
  misses is lower than for hits, but these runs don't reach it.
- **Where Postgres's time went:** the candidate query, ~57 ms of Postgres CPU per miss, almost
  all of the ~55m per req/s above. See the fix below. (A first read of one plan blamed the
  per-place lookup of the user's taste row and 20 ms of planning; measured over 200 queries,
  the lookup costs ~1 µs a place and planning ~2 ms once a connection is warm.)
- **The two miss runs aren't a clean A/B for offer churn.** A home walk stays near the 50
  homes with the most neighbours, mostly Manhattan: those cells average 144 places, against
  81 for the whole city that relocating users sample. Fewer candidates per miss outweigh
  the extra offer writes, which is why the churn run is cheaper. Relocating users also share
  more area-stats misses (71% hits), since they spread over every cell.

#### Ranking-query fix

`loadtest/rank-bench.sh` runs variants of the candidate query straight against Postgres for
200 (onboarded user, cell) pairs taken from the clean cache-miss run
([`pairs.json`](loadtest/rank-bench/pairs.json)). It reads the Postgres container's CPU from
its cgroup (so parallel workers and planning count) and checks that each variant returns the
same candidates as the original. First pass, median of 3 runs, per query
([1](loadtest/results/rank-bench-20261017-145511/report.md),
[2](loadtest/results/rank-bench-20261017-145621/report.md),
[3](loadtest/results/rank-bench-20261017-145717/report.md)):

| Variant | Postgres CPU | Wall | Execution p95 | Same candidates |
|---|---|---|---|---|
| Original | 57.2 ms | 31.1 ms | 72.5 ms | |
| No parallel workers | 21.3 ms | 22.3 ms | 66.0 ms | yes |
| Taste vector passed in instead of joined, no parallel workers | 20.9 ms | 22.1 ms | 64.5 ms | yes |
| No parallel workers + two-phase | 18.8 ms | 19.7 ms | 45.4 ms | yes |
| Same, radius filter on a sphere | 17.1 ms | 18.6 ms | 39.6 ms | no (22 of 40 pairs) |

- **Parallel workers were most of it.** The planner expects 3 rows from the geography radius
  filter (there are thousands), but still gave dense cells 3 parallel workers: ~4 ms less
  latency for 2.3x the CPU. Under load every core is already busy with other requests, so the
  API's pool turns them off (`max_parallel_workers_per_gather=0` as a connection option).
  That reaches only the API's own connections: the workers and batch jobs log in as the same
  database user, so `ALTER ROLE` would have taken parallelism from them too.
- **Two-phase:** rank on id + taste first, then fetch names, tags, links, distance and chain
  size for the 3,000 winners only. Dense cells have ~10k places in the radius, so this mostly
  cuts the tail.
- **Ruled out:** passing the taste vector in (no gain), and a sphere instead of the ellipsoid
  for the radius filter (~1 ms, but it changes which places sit inside 1.5 km).

**The old query wasn't deterministic.** In dense cells thousands of places share the lowest
taste (no tags in common with the user): in one pair 3,632 places in the radius tie, and
2,861 of them fill out the 3,000 candidates. With no tiebreak, *which* 2,861 depended on the
plan; a parallel and a serial run of the old query picked different ones, and other factors
(rarity, independence) can still lift one of them into the deck. The query now breaks ties by
id, so a request always gets the same deck. The tiebreak costs ~1–2 ms, inside this laptop's
noise: six interleaved runs, medians per query
([1](loadtest/results/rank-bench-20261017-152527/report.md),
[2](loadtest/results/rank-bench-20261017-152605/report.md),
[3](loadtest/results/rank-bench-20261017-152639/report.md),
[4](loadtest/results/rank-bench-20261017-152746/report.md),
[5](loadtest/results/rank-bench-20261017-152834/report.md),
[6](loadtest/results/rank-bench-20261017-152922/report.md); the same variant ranged 17–36 ms
between runs. Three runs just before, without the no-tiebreak variants, had the shipped query
at 25–32 ms: [1](loadtest/results/rank-bench-20261017-152156/report.md),
[2](loadtest/results/rank-bench-20261017-152244/report.md),
[3](loadtest/results/rank-bench-20261017-152333/report.md)):

| Variant (no parallel workers) | Postgres CPU | Execution p95 |
|---|---|---|
| One query, no tiebreak | 22.6 ms | ~67 ms |
| One query + id tiebreak | 21.5 ms (3 runs) | ~71 ms |
| Two-phase, no tiebreak | 19.5 ms | ~50 ms |
| **Two-phase + id tiebreak (shipped)** | **20.9 ms** (original: 57.2 ms, −63%) | **~50 ms** (original: 72.5 ms) |

[`candidates.db.spec.ts`](apps/api/src/quests/candidates.db.spec.ts) checks this against a
real database on the 200 pairs (skipped unless `TEST_DATABASE_URL` is set):
- the shipped query equals the old query with only the id tiebreak added, exactly:
  candidates, the ranked top 200 and the 10-place deck, for all 200 pairs;
- against the old query as it was, every candidate above the tie matches, and the number of
  tied ones (27 of the 200 pairs have ties at the limit);
- API connections run without parallel workers; a plain connection as the same user keeps
  the default.

End to end, the same clean cache-miss test on the new image
([report](loadtest/results/cold-home-fix-20261017-150126/report.md)):

| Clean cache miss, 100 VUs | Before | After |
|---|---|---|
| Postgres CPU | ~5.1 cores (55m per req/s) | **~2.9 cores (31m per req/s, −44%)** |
| API CPU per req/s | 44m | 49m |
| p50 / p95 / p99 | 70 / 178 / 267 ms | **59 / 151 / 217 ms** |
| Throughput, errors, deck hits | 92 req/s, 0, 0.1% | 93 req/s, 0, 0.1% |

- **The bottleneck moved to the API,** which scales out: Postgres now spends less per miss than
  the API does. Each request also runs a few small queries (offer, survey, taste), so the saving
  per request (~24 ms) is below the query's ~38 ms; under real load the original also couldn't
  always get its 3 workers.
- **API CPU up 12%:** nothing changed on its side (same rows, same scoring), and that's inside
  the run-to-run spread seen today; an A/B in one session would settle it.

**Chain size on the place.** The indie score needs each candidate's chain size, which the
query looked up in `chain_stats` once per winner (3,000 index probes). Migration
[0008](db/migrations/0008_place_chain_locations.up.sql) stores it on the place
(`places.chain_locations`), and [`stats.Recompute`](workers/internal/stats/stats.go) keeps it
current for every chain present in a refreshed area, wherever its other locations are.
`chain_stats` was written alongside it for one release, for API pods still reading it during
the rollout; migration [0009](db/migrations/0009_drop_chain_stats.up.sql) then dropped it.
Six interleaved runs, alternating which variant went first, medians per query
([1](loadtest/results/rank-bench-20261017-155013/report.md),
[2](loadtest/results/rank-bench-20261017-155038/report.md),
[3](loadtest/results/rank-bench-20261017-155101/report.md),
[4](loadtest/results/rank-bench-20261017-155125/report.md),
[5](loadtest/results/rank-bench-20261017-155149/report.md),
[6](loadtest/results/rank-bench-20261017-155213/report.md)):

| Variant | Postgres CPU | Execution p95 |
|---|---|---|
| Two-phase, chain size from `chain_stats` | 22.4 ms | ~54 ms |
| **Two-phase, chain size on the place (shipped)** | **16.9 ms (−24%)** | **~42 ms** |

The column was faster in 5 of the 6 pairs, by a median 4.4 ms. `candidates.db.spec.ts` checks
that every place's `chain_locations` equals a live count of its chain, and its exact-equality
check on the 200 pairs compares against the original query (`rank-bench/archive/current.sql`,
its `chain_stats` join swapped for that live count);
`workers/internal/stats/stats_test.go` checks `Recompute` (counts across areas, untouched
chains left alone). Against the original query (57.2 ms, p95 72.5 ms) the miss path is now
about 3.4x cheaper in Postgres.

- **Stats refreshes run one at a time.** Two ingests of different areas can share a chain.
  Under READ COMMITTED each counts from its own snapshot, and an UPDATE that waits on a row
  lock re-checks its WHERE against the newer row but keeps its own count, so a refresh that
  counted before a new location committed could overwrite the newer count. `Recompute` takes
  one `pg_advisory_xact_lock` before it reads anything, so each refresh counts with a snapshot
  taken after the previous one committed. The `chain_stats` upsert, whose row lock is held to
  commit, used to serialize refreshes by accident (and could deadlock two of them, since it
  locked chains in hash order); without it the race is real.
  `TestRecomputeConcurrentRefreshesOfOneChain` forces the interleaving: without the lock and
  without the `chain_stats` write it ends with a stale count (3, want 4); with the lock it
  passes.
  - *One lock, not one per chain.* The first version locked each chain in the refreshed areas,
    which let refreshes of unrelated chains run in parallel. A full NYC load refreshes ~70k
    chains, and Postgres keeps advisory locks in a shared table sized at about
    `max_locks_per_transaction` × `max_connections` (64 × 100 = 6,400): the documented
    `load-places` step failed with `out of shared memory` (SQLSTATE 53200). Midtown's 10,967
    chains still fit, by borrowing spare shared memory, which is luck rather than design. A
    refresh takes 0.4 s for Midtown and 1.2 s for all of NYC, and runs once per ingested area,
    so serializing them costs nothing that matters. Hashing chains into 1,024 buckets would
    have kept some parallelism, but a dense area touches nearly every bucket anyway.
- **Migrations run before the rollout now.** The migrate Job was a post-upgrade hook, so new
  pods started before the schema they need; it's now pre-upgrade (post-install on a fresh
  install, where the Postgres cluster comes from the same release). Migrations must keep
  working for the old pods still running: add in one release, drop in a later one.
- **Next:** distances are ~3 ms of what's left, and the 3,000-candidate cap drives the API's
  parse cost; cutting it needs the equivalence test to show the deck doesn't change.

---

## Demo profile (one small VM)

[`values-demo.yaml`](infra/helm/larper/values-demo.yaml) runs the whole architecture for an
always-on demo (a few users, under 1 req/s) on one small VM. It's a layer over a target's
values, applied last:

```bash
helm upgrade --install larper infra/helm/larper -n larper -f infra/helm/larper/values-oci.yaml \
  -f infra/helm/larper/values-demo.yaml          # Oracle k3s (or just -f values-demo.yaml on k3d)
```

It changes sizes only: 1 API replica (HPA max 2), one taste-worker and one ingest-worker,
Redpanda on one core with Seastar capped at 384M (container 512Mi), Postgres with
`shared_buffers` 128MB, `work_mem` 4MB and `max_connections` 50, DuckDB capped at 384MB and
one thread, Redis as it is, and requests set to the measured steady usage. Monitoring is off:
kube-prometheus-stack alone takes ~0.8 GiB. To turn it back on, install it
(`./scripts/monitoring.sh`) and add `--set monitoring.enabled=true`. The full profile is
unchanged: every existing values file renders the same Kubernetes objects as before.

Measured on k3d with `loadtest/footprint.sh` (every pod via `kubectl top`, every 3–10 s),
all pods except monitoring (the app, kube-system's CoreDNS, Traefik and metrics-server, and
the CNPG operator):

| Demo profile | CPU mean / peak | Memory mean / peak |
|---|---|---|
| [Idle](loadtest/results/footprint-demo-idle-20261017-174412/report.md) (after warm-up) | 64m / 81m | 754 Mi / 759 Mi |
| [8 VUs](loadtest/results/footprint-demo-8vus-20261017-174743/report.md), ~8 req/s for 3 min | 261m / 328m | 841 Mi / 867 Mi |
| [Ingest of a new area](loadtest/results/footprint-demo-ingest-20261017-174114/report.md) | 205m / 410m | 789 Mi / 876 Mi |
| [Full profile, idle](loadtest/results/footprint-full-idle-20261017-172940/report.md), for comparison | 85m / 108m | 423 Mi / 424 Mi (+ 824 Mi monitoring) |

- **Idle memory is higher than the full profile's fresh idle**, because `kubectl top` counts
  each pod's active page cache: Postgres sits at ~340 Mi once `shared_buffers` and its cache
  are warm, and the ingest-worker keeps ~140 Mi after a DuckDB run. That's the steady state of
  an always-on demo, so the requests are set to it.
- **At 8 VUs** (8× the demo's load; warm users): 0 errors, p50 16 ms, p95 41 ms, max 440 ms,
  and the API scaled 1 → 2.
- **End to end** (`loadtest/e2e-check.sh`): a quest near Washington Square; accept and check-in
  (201), the taste-worker applying both events (`taste_profiles.source = 'events'`), the
  outbox drained; and quests in White Plains and Stamford, which weren't ingested: each
  survey (two geohash5 areas) loaded in ~56 s and the next request got a quest there.

**Smallest VM: 2 vCPU / 4 GB; comfortable: 6 GB.** On one node the cluster's own processes
come on top of the pods (measured inside the k3d server node):

| | Memory |
|---|---|
| Pods, peak (above) | ~0.9 GiB |
| k3s (API server, controllers, SQLite, kubelet, flannel in one process) | ~1.0 GiB RSS |
| containerd and one shim per pod | ~0.3–0.4 GiB |
| OS (Ubuntu server: systemd, sshd, journald) | ~0.3 GiB |
| **In use at peak** | **~2.5–2.7 GiB** |

On 4 GB that leaves ~1.3 GB for the page cache (Postgres reads through it) and spikes; 6 GB
leaves room to turn monitoring back on. CPU stays under half a core for the pods at 8× the
demo's load, so 2 vCPU leaves the rest for k3s. The k3s figure is from this k3d cluster, whose
API server also carries kube-prometheus-stack's CRDs; without them it should be lower, but it
wasn't measured that way. Nothing here was measured on an actual 4 GB VM.

The Oracle A1 target runs this profile on 1 OCPU / 6 GB (`scripts/oci-up.sh` layers
`values-demo.yaml` over `values-oci.yaml`). Memory has room there. An A1 OCPU is a single
core, though, so CPU is the tight side; see
[infra/oci-k3s](infra/oci-k3s/README.md#deploy).

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
- [x] **8. Deploy + prove it:** Prometheus/Grafana, k6 load test showing the HPA scale out (k3d and EKS), SQS queue, failure test, autoscaler sizing, cache-miss test, Terraform EKS + Karpenter (applied, load tested, destroyed), always-free k3s on Oracle Ampere A1 (bootstrap, backups and runbook in `infra/oci-k3s`, rehearsed on a local stand-in VM including a k3s restart under load and a restore).
- [ ] **Next:** Oracle A1 deploy once the probe finds capacity; optional EKS failure test; a smaller candidate cap once the equivalence test shows the deck doesn't change.
