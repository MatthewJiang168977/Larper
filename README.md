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
pnpm api:dev                 # API alone on :3000
./scripts/up.sh              # full stack on k3d (Git Bash)
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

## Status
- [x] Milestone 1: skeleton. k3d cluster with 2 API replicas behind Traefik, autoscaler, Postgres (PostGIS 3.6 + pgvector 0.8), Redis, Redpanda.
- [x] Milestone 2: Overture extract (DuckDB), niche taxonomy + tag vectors, PostGIS load, area/chain stats.
- [ ] Milestone 3: Clerk auth, onboarding, initial taste vector
