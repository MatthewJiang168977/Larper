# Larper

Find the most niche thing to do near you, shown on a 3D map of your surroundings.
Full design: see `docs/` (coming) and the build plan.

## Stack
Next.js PWA + MagicUI · NestJS API · Go workers · Postgres (PostGIS + pgvector) · Redis ·
Redpanda (Kafka) · Azure Service Bus · Clerk · Kubernetes (k3d locally, AKS in prod) · Traefik ingress

## Prerequisites (Windows)
```powershell
winget install Docker.DockerDesktop   # restart afterwards, start Docker Desktop once
winget install k3d.k3d Helm.Helm Kubernetes.kubectl GoLang.Go
```

## Run locally
```bash
pnpm install
./scripts/up.sh              # full stack on k3d (Git Bash)
pnpm web:dev                 # web app on :3001, /api/* proxied to the cluster (:8080)
pnpm api:dev                 # API alone on :3000, if you want it outside the cluster
for i in 1 2 3 4; do curl -s localhost:8080/healthz; echo; done   # pod name changes = load balancing works
./scripts/down.sh
```

## Load place data (NYC)
Migrations in `db/migrations` run automatically as a Helm post-install/upgrade Job.
```bash
pip install duckdb
python data/extract_overture.py --out data/nyc.parquet        # ~566k places, ~1 min, 27 MB
kubectl -n larper port-forward svc/pg-rw 55432:5432 &
PW=$(kubectl -n larper get secret pg-app -o jsonpath='{.data.password}' | base64 -d)
cd workers && DATABASE_URL="postgres://larper:$PW@127.0.0.1:55432/larper?sslmode=require" \
  go run ./cmd/load-places -in ../data/nyc.parquet           # ~80k quest-worthy places, idempotent
```
Tags come from `workers/internal/taxonomy/taxonomy.yaml` (150 niche tags, fixed vector slots).

## Auth
Clerk handles sign-in in `apps/web` (keys in `apps/web/.env.local`, written by `clerk init`, gitignored).
The API only needs the public publishable key (`infra/helm/larper/values.yaml`): it verifies
session JWTs against the Clerk instance's JWKS and checks `azp`. Users are created on first call.

## Quests
`GET /quests/today?lat&lng[&radius]` returns today's quest plus a 9-card deck. Scoring lives in
`apps/api/src/quests/scoring.ts`:

    score = (0.7·fit + 0.3·rarity) · indie-multiplier · quality-multiplier · exp(-d / radius)

`fit` is taste cosine relative to the best match nearby, `rarity` is the place's rarest tag vs the
surrounding geohash6 cells, chains lose up to 40%. MMR re-ranking keeps the deck varied.
Tune with `QUEST_WEIGHTS='{"taste":0.8}'`. Redis caches area stats (shared, 1h) and each user's
scored deck (10 min; the key includes the taste version, so taste changes never serve stale decks).
`POST /quests/:id/accept|skip|complete` moves the quest through its state machine.

## Map
`apps/web/components/map/` renders the quest map with MapLibre over OpenFreeMap (OpenStreetMap
vector tiles, free, no key) in a hand-written field-journal style with 3D buildings. Renderers
implement `QuestMapProps` (`quest-map.ts`), so Google Photorealistic 3D Tiles can replace it later.
Test from a desktop with `http://localhost:3001/?at=40.7295,-73.9965`; without GPS the app falls
back to Washington Square.

## Status
- [x] Milestone 1: skeleton. k3d cluster with 2 API replicas behind Traefik, autoscaler, Postgres (PostGIS 3.6 + pgvector 0.8), Redis, Redpanda.
- [x] Milestone 2: Overture extract (DuckDB), niche taxonomy + tag vectors, PostGIS load, area/chain stats.
- [x] Milestone 3: Clerk sign-in, JWKS-verified API guard, vibe-swipe onboarding seeding the taste vector.
- [x] Milestone 4: niche scoring + MMR, Redis cache-aside, quest state machine, zero-downtime rollouts.
- [x] Milestone 5: field-journal 3D map (MapLibre + OpenFreeMap), quest sheet with reasons and links, journal page, PWA manifest. Google 3D Tiles/Places deferred (no billing).
- [ ] Milestone 6: outbox -> Kafka events, taste-worker, geofenced check-in
