#!/usr/bin/env bash
# Build and push all five images for amd64 + arm64 (one manifest list per image), so
# the same tag runs on x86 nodes (AKS, EKS, k3d) and ARM nodes (OCI Ampere A1 k3s).
#
#   REGISTRY=localhost:5111 scripts/build-images.sh            # k3d registry, tag = git commit
#   REGISTRY=myacr.azurecr.io TAG=v1 scripts/build-images.sh
#
# Go and the API's JS build cross-compile natively; only the final stages (apt for
# PostGIS, DuckDB's extension install) run under QEMU for the foreign architecture.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${REGISTRY:?set REGISTRY, e.g. localhost:5111}"
TAG=${TAG:-$(git rev-parse --short HEAD)$(git diff --quiet HEAD || echo -dirty)}
PLATFORMS=${PLATFORMS:-linux/amd64,linux/arm64}

# Multi-platform builds need a docker-container builder. Host networking lets it push
# to the k3d registry on localhost; the config allows that registry's plain HTTP.
if ! docker buildx inspect larper-multi >/dev/null 2>&1; then
  cfg=$(mktemp)
  printf '[registry."localhost:5111"]\n  http = true\n' > "$cfg"
  docker buildx create --name larper-multi --driver docker-container \
    --driver-opt network=host --buildkitd-config "$cfg" >/dev/null
  rm -f "$cfg"
fi

build() { # image name, tag, then docker build args
  local name=$1 tag=$2; shift 2
  echo "==> $REGISTRY/$name:$tag ($PLATFORMS)"
  docker buildx build --builder larper-multi --platform "$PLATFORMS" \
    -t "$REGISTRY/$name:$tag" --push "$@"
}
PG_TAG=$(scripts/pg-tag.sh "$TAG")
build larper-postgres "$PG_TAG" infra/postgres
build larper-migrate "$TAG" db
build larper-workers "$TAG" --target static workers
build larper-ingest "$TAG" --target ingest workers
build larper-api "$TAG" -f apps/api/Dockerfile .

echo "Pushed tag $TAG (Postgres: $PG_TAG)"
