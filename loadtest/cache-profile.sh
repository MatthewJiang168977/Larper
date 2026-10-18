#!/usr/bin/env bash
# Cache hit rate + CPU profile under steady load. Needs the chart with
# api.cpuProfiling=true (the profile endpoint is off otherwise).
#
#   CLERK_SECRET_KEY=sk_test_... loadtest/cache-profile.sh <label>
#   VUS=20 DURATION=4m WARMUP=90 PROFILE_S=60 loadtest/cache-profile.sh <label>
#
# Cache counters are summed over all API pods at the start, after WARMUP seconds,
# and at the end, so the report has a whole-run and a warm hit rate. One pod is
# profiled for PROFILE_S seconds after the warmup. Output: loadtest/results/
# profile-<label>-<time>/ (report.md, api.cpuprofile for speedscope/DevTools).
set -uo pipefail
cd "$(dirname "$0")/.."

: "${CLERK_SECRET_KEY:?set CLERK_SECRET_KEY}"
LABEL=${1:?usage: cache-profile.sh <label>}
NS=${NS:-larper}
VUS=${VUS:-20}
DURATION=${DURATION:-4m}
WARMUP=${WARMUP:-90}
PROFILE_S=${PROFILE_S:-60}
OUT=loadtest/results/profile-$LABEL-$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"
# k6 writes the test users' Clerk session IDs into summary.json: strip them however the run ends.
trap 'node loadtest/redact.js "$OUT"' EXIT
K6=${K6:-$(command -v k6 || command -v k6.exe)}
[[ -n "$K6" ]] || { echo "k6 not found (set K6=path)"; exit 1; }

pods() { kubectl -n "$NS" get pods -l app=api -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'; }
# 127.0.0.1, not localhost: busybox wget resolves localhost to ::1, and the metrics
# server listens on IPv4.
metric() { kubectl -n "$NS" exec "$1" -- wget -qO- "http://127.0.0.1:9464$2"; }
counters() { # label: one "cache result value" line per series, summed over pods
  for p in $(pods); do metric "$p" /metrics | grep '^cache_lookups_total'; done |
    sed -E 's/cache_lookups_total\{cache="([^"]+)",result="([^"]+)"\} ([0-9.e+]+)/\1 \2 \3/' |
    awk -v at="$1" '{s[$1" "$2]+=$3} END {for (k in s) print at, k, s[k]}' >>"$OUT/cache.txt"
}

kubectl -n "$NS" get deploy api -o jsonpath='{.spec.template.spec.containers[0].resources}' >"$OUT/resources.json"
counters start
SCENARIO=steady VUS=$VUS DURATION=$DURATION "$K6" run --quiet \
  --out "csv=$OUT/k6.csv" --summary-export "$OUT/summary.json" loadtest/quests.js >"$OUT/k6.log" 2>&1 &
K6_PID=$!

sleep "$WARMUP"
counters warm
POD=$(pods | head -1)
echo "$POD" >"$OUT/profiled-pod.txt"
kubectl -n "$NS" top pods -l app=api --no-headers >"$OUT/top-before-profile.txt" 2>/dev/null
metric "$POD" "/debug/cpu-profile?seconds=$PROFILE_S" >"$OUT/api.cpuprofile"
kubectl -n "$NS" top pods -l app=api --no-headers >"$OUT/top-after-profile.txt" 2>/dev/null

wait "$K6_PID"
echo "k6 exit $?" >>"$OUT/k6.log"
counters end

node loadtest/profile-report.js "$OUT" | tee "$OUT/report.md"
