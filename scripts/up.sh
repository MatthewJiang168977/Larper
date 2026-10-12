#!/usr/bin/env bash
# Bring up the full local stack on k3d. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! k3d cluster list larper >/dev/null 2>&1; then
  k3d cluster create --config infra/k3d/cluster.yaml
fi

# CloudNativePG operator (manages the Postgres cluster).
helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null 2>&1 || true
helm upgrade --install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace --wait

docker build -t localhost:5111/larper-postgres:17 infra/postgres
docker push localhost:5111/larper-postgres:17

docker build -t localhost:5111/larper-migrate:dev db
docker push localhost:5111/larper-migrate:dev

docker build --target static -t localhost:5111/larper-workers:dev workers
docker push localhost:5111/larper-workers:dev
docker build --target ingest -t localhost:5111/larper-ingest:dev workers
docker push localhost:5111/larper-ingest:dev

# Build the API image and push it to the cluster's local registry.
docker build -f apps/api/Dockerfile -t localhost:5111/larper-api:dev .
docker push localhost:5111/larper-api:dev

helm upgrade --install larper infra/helm/larper -n larper --create-namespace
kubectl -n larper rollout restart deploy/api deploy/outbox-relay deploy/taste-worker deploy/ingest-worker
kubectl -n larper rollout status deploy/api --timeout=180s

echo "Up. Try: for i in 1 2 3 4; do curl -s localhost:8080/healthz; echo; done"
