#!/usr/bin/env bash
# Build and push all five images for amd64 + arm64 (one manifest list per image), so
# the same tag runs on x86 nodes (AKS, EKS, k3d) and ARM nodes (OKE Ampere A1).
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

build() { # image name, then docker build args
  local name=$1; shift
  echo "==> $REGISTRY/$name:$TAG ($PLATFORMS)"
  docker buildx build --builder larper-multi --platform "$PLATFORMS" \
    -t "$REGISTRY/$name:$TAG" --push "$@"
}
build larper-postgres infra/postgres
build larper-migrate db
build larper-workers --target static workers
build larper-ingest --target ingest workers
build larper-api -f apps/api/Dockerfile .

echo "Pushed tag $TAG"
