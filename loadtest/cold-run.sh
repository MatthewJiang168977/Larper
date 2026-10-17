#!/usr/bin/env bash
# Cache-miss test (SCENARIO=cold in quests.js): users ask for decks in cells they
# haven't visited, and Redis is flushed right before k6 starts, so nearly every deck
# is ranked from Postgres. Ramps to PEAK_VUS (100) and holds HOLD (3m). Records the
# same autoscaler/CPU trace as hpa-run.sh plus the cache counters, and checks that
# no ingest job was started.
#
#   CLERK_SECRET_KEY=sk_test_... loadtest/cold-run.sh <label>                      # clean miss
#   CLERK_SECRET_KEY=sk_test_... COLD_MODE=relocate loadtest/cold-run.sh <label>   # miss + offer churn
#
# COLD_MODE=home (default): each user's VUs walk fresh cells within 4.9 km of the
# user's home cell, so offers never go stale; after each walk the VU re-posts the
# same onboarding answers to get fresh cache keys (counted in the report).
# COLD_MODE=relocate: users jump anywhere in the city on every request, so each
# request also expires the last offer and inserts a new one.
# 50 users (COLD_USERS) for 100 VUs: Clerk dev instances stop at 100 users.
set -uo pipefail
cd "$(dirname "$0")/.."

[[ -n "${CLERK_SECRET_KEY:-}" ]] ||
  export CLERK_SECRET_KEY=$(grep -E '^CLERK_SECRET_KEY=' apps/web/.env.local 2>/dev/null | cut -d= -f2- | tr -d '"\r')
: "${CLERK_SECRET_KEY:?set CLERK_SECRET_KEY (or put it in apps/web/.env.local)}"
LABEL=${1:?usage: cold-run.sh <label>}
NS=${NS:-larper}
PEAK_VUS=${PEAK_VUS:-100}
HOLD=${HOLD:-3m}
COLD_MODE=${COLD_MODE:-home}
MIN_PLACES=${MIN_PLACES:-20}
STAMP=cold-$COLD_MODE-$LABEL-$(date +%Y%m%d-%H%M%S)
OUT=loadtest/results/$STAMP
mkdir -p "$OUT"
K6=${K6:-$(command -v k6 || command -v k6.exe)}
[[ -n "$K6" ]] || { echo "k6 not found (set K6=path)"; exit 1; }

psql() { kubectl -n "$NS" exec pg-1 -c postgres -- psql -U postgres -d larper -Atc "$1"; }

# Cells to send users to.
psql "SELECT a.geohash6, ST_YMin(g), ST_XMin(g), ST_YMax(g), ST_XMax(g)
      FROM area_totals a, ST_GeomFromGeoHash(a.geohash6) g WHERE a.places >= $MIN_PLACES" |
  tr '|' '\t' >"$OUT/cells.tsv"
psql 'SELECT geohash5 FROM areas_ingested' >"$OUT/areas.txt"
node loadtest/cold-cells.js "$OUT/cells.tsv" "$OUT/areas.txt" >"$OUT/cells.json" || exit 1
node -e "const c = require('./$OUT/cells.json'); const n = c.near.filter((x) => x.length >= (process.env.MIN_NEAR || 50)).length;
  console.log(c.cells.length + ' cells, ' + n + ' home cells')" | tee "$OUT/cells-count.txt"

kubectl -n "$NS" get deploy api -o jsonpath='{.spec.template.spec.containers[0].resources}' >"$OUT/resources.json"
kubectl -n "$NS" get hpa api -o json >"$OUT/hpa.json" 2>/dev/null || echo '{}' >"$OUT/hpa.json"
psql "SELECT count(*) FROM jobs WHERE queue = 'ingest-area'" >"$OUT/ingest-jobs-before.txt"

# Cache counters summed over the API pods (as in cache-profile.sh).
pods() { kubectl -n "$NS" get pods -l app=api -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'; }
counters() {
  for p in $(pods); do kubectl -n "$NS" exec "$p" -- wget -qO- http://127.0.0.1:9464/metrics | grep '^cache_lookups_total'; done |
    sed -E 's/cache_lookups_total\{cache="([^"]+)",result="([^"]+)"\} ([0-9.e+]+)/\1 \2 \3/' |
    awk -v at="$1" '{s[$1" "$2]+=$3} END {for (k in s) print at, k, s[k]}' >>"$OUT/cache.txt"
}

record() { # same columns as hpa-run.sh: epoch, replicas, desired, util %, per-pod API CPU, Postgres, Redis
  while :; do
    local t r d u top cpu pg redis
    t=$(date +%s)
    read -r r d u < <(kubectl -n "$NS" get hpa api \
      -o jsonpath='{.status.currentReplicas} {.status.desiredReplicas} {.status.currentMetrics[0].resource.current.averageUtilization}' 2>/dev/null)
    top=$(kubectl -n "$NS" top pods --no-headers 2>/dev/null)
    cpu=$(awk '$1 ~ /^api-/ {gsub("m","",$2); printf "%s%s", sep, $2; sep=","}' <<<"$top")
    pg=$(awk '$1 ~ /^pg-/ {gsub("m","",$2); s+=$2} END {print s+0}' <<<"$top")
    redis=$(awk '$1 ~ /^redis-/ {gsub("m","",$2); s+=$2} END {print s+0}' <<<"$top")
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$t" "${r:-}" "${d:-}" "${u:-}" "$cpu" "$pg" "$redis" >>"$OUT/hpa.tsv"
    sleep 5
  done
}

REDIS=$(kubectl -n "$NS" get pods -o name | grep -m1 '^pod/redis-')
kubectl -n "$NS" exec "${REDIS#pod/}" -- redis-cli FLUSHALL
counters start
record &
REC=$!
trap 'kill $REC 2>/dev/null' EXIT

SCENARIO=cold COLD_MODE=$COLD_MODE PEAK_VUS=$PEAK_VUS HOLD=$HOLD CELLS="results/$STAMP/cells.json" \
  "$K6" run --quiet --out "csv=$OUT/k6.csv" --summary-export "$OUT/summary.json" loadtest/quests.js >"$OUT/k6.log" 2>&1
echo "k6 exit $?" >>"$OUT/k6.log"
counters end
sleep 10
kill $REC 2>/dev/null
psql "SELECT count(*) FROM jobs WHERE queue = 'ingest-area'" >"$OUT/ingest-jobs-after.txt"

{
  node loadtest/hpa-report.js "$OUT"
  echo
  echo '## Cache'
  echo
  echo '| cache | hits | misses | errors | hit rate |'
  echo '|---|---|---|---|---|'
  awk '{v[$1" "$2" "$3]=$4; c[$2]=1}
       END {for (k in c) {h=v["end "k" hit"]-v["start "k" hit"]; m=v["end "k" miss"]-v["start "k" miss"]; e=v["end "k" error"]-v["start "k" error"];
            printf "| %s | %d | %d | %d | %.1f%% |\n", k, h, m, e, (h+m) ? 100*h/(h+m) : 0}}' "$OUT/cache.txt"
  echo
  echo "Re-onboards during the run (taste_profiles upserts): $(grep -c '^http_reqs,.*,onboard,' "$OUT/k6.csv")."
  echo "Ingest jobs before / after: $(cat "$OUT/ingest-jobs-before.txt") / $(cat "$OUT/ingest-jobs-after.txt"). Cells: $(cat "$OUT/cells-count.txt")."
} | tee "$OUT/report.md"
