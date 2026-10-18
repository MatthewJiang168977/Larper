#!/usr/bin/env bash
# Run before `helm upgrade` (the up scripts do). Gives the database owner, larper,
# CREATEROLE on a Postgres cluster created before the per-service roles (migration 0010),
# so that release's migration can create them.
#
# The chart asks CloudNativePG for it (the owner's managed role in
# templates/postgres.yaml), but Helm applies that change to the Cluster only after the
# pre-upgrade migrate Job has finished, and the Job waits for it: on such a cluster the
# first upgrade would time out. Once the release is in, CNPG keeps the attribute, so
# this is a no-op from then on, and on a fresh install (no cluster yet) it does nothing.
set -euo pipefail
NS=${NS:-larper}

pod=$(kubectl -n "$NS" get pods -l cnpg.io/cluster=pg,cnpg.io/instanceRole=primary -o name 2>/dev/null | head -n1 || true)
if [[ -z $pod ]]; then
  echo "pg-owner-createrole: no Postgres primary in namespace $NS yet; nothing to do"
  exit 0
fi
kubectl -n "$NS" exec "$pod" -c postgres -- psql -U postgres -d postgres -XAtq -v ON_ERROR_STOP=1 \
  -c 'ALTER ROLE larper CREATEROLE'
echo "pg-owner-createrole: larper has CREATEROLE"
