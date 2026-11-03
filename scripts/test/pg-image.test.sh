#!/usr/bin/env bash
# Builds infra/postgres and checks that the extensions the migrations need load in it:
# PostGIS (added by the Dockerfile) and pgvector (from the CNPG base). Runs in CI so
# base-image bumps (Dependabot) are tested before they merge.
set -euo pipefail
cd "$(dirname "$0")/../.."
img=larper-postgres:test
docker build -q -t "$img" infra/postgres >/dev/null
docker run --rm -i "$img" bash -ec '
  bin=$(ls -d /usr/lib/postgresql/*/bin | head -1)
  "$bin/initdb" -D /tmp/pg -U postgres >/dev/null 2>&1
  "$bin/pg_ctl" -D /tmp/pg -o "-k /tmp -c listen_addresses=" -w start >/dev/null
  psql -h /tmp -U postgres -v ON_ERROR_STOP=1 -qAt
' <<'SQL'
CREATE EXTENSION postgis;
CREATE EXTENSION vector;
SELECT 'server ' || current_setting('server_version') || ', postgis ' || postgis_lib_version()
    || ', vector ' || (SELECT extversion FROM pg_extension WHERE extname = 'vector');
SQL
echo "pg-image: PostGIS and pgvector load"
