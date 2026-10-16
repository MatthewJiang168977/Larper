#!/usr/bin/env bash
# Prints the Postgres image tag for a build tag: 17-3f9c2e1 for "3f9c2e1".
# CloudNativePG reads the Postgres major version from the image tag and rejects a
# Cluster whose tag doesn't start with one, so a bare commit hash won't do. The major
# comes from infra/postgres/Dockerfile's base image.
set -euo pipefail
cd "$(dirname "$0")/.."
major=$(sed -n 's/^FROM .*postgresql:\([0-9][0-9]*\).*/\1/p' infra/postgres/Dockerfile)
[[ -n $major ]] || { echo "no Postgres major in infra/postgres/Dockerfile" >&2; exit 1; }
echo "$major-${1:?build tag}"
