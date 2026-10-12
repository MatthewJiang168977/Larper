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

## Status
- [x] Milestone 1: skeleton. k3d cluster with 2 API replicas behind Traefik, autoscaler, Postgres (PostGIS 3.6 + pgvector 0.8), Redis, Redpanda.
- [ ] Milestone 2: Overture data load, taxonomy, area stats
