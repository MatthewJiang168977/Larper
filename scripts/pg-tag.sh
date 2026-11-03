#!/usr/bin/env bash
# Prints the Postgres image tag, such as 17-4b1e0c9a2f7d: the Postgres major, then a
# hash of what's in infra/postgres (the image's whole build context).
#
# The tag follows the image's contents, not the commit. The Cluster spec changes only
# when the image does, so a deploy that doesn't touch infra/postgres leaves the tag, the
# Cluster and the running Postgres alone. A commit tag (17-<commit>) restarted Postgres
# on every deploy.
#
# CloudNativePG reads the Postgres major from the tag and rejects a Cluster whose tag
# doesn't start with one, so a bare hash won't do. The major comes from the Dockerfile's
# base image.
#
# Every file in the directory counts, committed or not, so a local edit gets its own tag
# and a dirty tree needs no -dirty suffix. git hash-object hashes the same on every OS.
# The base image is pinned by digest, and Dependabot (.github/dependabot.yml) opens a PR
# when it moves: merging that changes the tag, so the next deploy restarts Postgres
# once on the patched image. The PostGIS package isn't pinned; it's whatever PGDG has
# when the image is built, which is only when the tag changes.
set -euo pipefail
cd "$(dirname "$0")/.."
major=$(sed -n 's/^FROM .*postgresql:\([0-9][0-9]*\).*/\1/p' infra/postgres/Dockerfile)
[[ -n $major ]] || { echo "no Postgres major in infra/postgres/Dockerfile" >&2; exit 1; }
hash=$(cd infra/postgres && find . -type f | LC_ALL=C sort | while IFS= read -r f; do
  printf '%s %s\n' "$f" "$(git hash-object --no-filters -- "$f")"
done | git hash-object --stdin)
echo "$major-${hash:0:12}"
