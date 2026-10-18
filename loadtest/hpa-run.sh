#!/usr/bin/env bash
# Run k6 while recording the API autoscaler every 5 s, then summarise load vs
# replicas vs CPU (loadtest/hpa-report.js). Used for the HPA decision record
# (docs/decisions/0001-hpa-cpu-request.md).
#
#   CLERK_SECRET_KEY=sk_test_... loadtest/hpa-run.sh before            # 8 min ramp to 200 VUs
#   SCENARIO=steady VUS=20 DURATION=3m loadtest/hpa-run.sh low-load    # light constant load
#   SCENARIO=steps loadtest/hpa-run.sh sizing                          # 20..100 VUs, 90 s each
set -uo pipefail
cd "$(dirname "$0")/.."

: "${CLERK_SECRET_KEY:?set CLERK_SECRET_KEY}"
LABEL=${1:?usage: hpa-run.sh <label>}
NS=${NS:-larper}
OUT=loadtest/results/hpa-$LABEL-$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"
# k6 writes the test users' Clerk session IDs into summary.json: strip them however the run ends.
trap 'node loadtest/redact.js "$OUT"' EXIT
K6=${K6:-$(command -v k6 || command -v k6.exe)}
[[ -n "$K6" ]] || { echo "k6 not found (set K6=path)"; exit 1; }

# Settings under test, for the report header.
kubectl -n "$NS" get deploy api -o jsonpath='{.spec.template.spec.containers[0].resources}' >"$OUT/resources.json"
kubectl -n "$NS" get hpa api -o json >"$OUT/hpa.json" 2>/dev/null || echo '{}' >"$OUT/hpa.json"

# epoch, replicas, desired, HPA utilisation %, per-pod API CPU (m), Postgres CPU (m),
# Redis CPU (m) from metrics-server. The last two show whether the API or a
# dependency is the bottleneck.
record() {
  while :; do
    local t r d u top cpu pg redis
    t=$(date +%s)
    read -r r d u < <(kubectl -n "$NS" get hpa api \
      -o jsonpath='{.status.currentReplicas} {.status.desiredReplicas} {.status.currentMetrics[0].resource.current.averageUtilization}' 2>/dev/null)
    [[ -z "${r:-}" ]] && r=$(kubectl -n "$NS" get deploy api -o jsonpath='{.status.readyReplicas}')
    top=$(kubectl -n "$NS" top pods --no-headers 2>/dev/null)
    cpu=$(awk '$1 ~ /^api-/ {gsub("m","",$2); printf "%s%s", sep, $2; sep=","}' <<<"$top")
    pg=$(awk '$1 ~ /^pg-/ {gsub("m","",$2); s+=$2} END {print s+0}' <<<"$top")
    redis=$(awk '$1 ~ /^redis-/ {gsub("m","",$2); s+=$2} END {print s+0}' <<<"$top")
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$t" "${r:-}" "${d:-}" "${u:-}" "$cpu" "$pg" "$redis" >>"$OUT/hpa.tsv"
    sleep 5
  done
}
record &
REC=$!
trap 'kill $REC 2>/dev/null; node loadtest/redact.js "$OUT"' EXIT

"$K6" run --quiet --out "csv=$OUT/k6.csv" --summary-export "$OUT/summary.json" loadtest/quests.js >"$OUT/k6.log" 2>&1
echo "k6 exit $?" >>"$OUT/k6.log"
sleep 10
kill $REC 2>/dev/null

node loadtest/hpa-report.js "$OUT" | tee "$OUT/report.md"
