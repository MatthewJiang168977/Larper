#!/usr/bin/env bash
# Run k6 while recording the API autoscaler every 5 s, then summarise load vs
# replicas vs CPU (loadtest/hpa-report.js). Used for the HPA decision record
# (docs/decisions/0001-hpa-cpu-request.md).
#
#   CLERK_SECRET_KEY=sk_test_... loadtest/hpa-run.sh before            # 8 min ramp to 200 VUs
#   SCENARIO=steady VUS=20 DURATION=3m loadtest/hpa-run.sh low-load    # light constant load
#   SCENARIO=steps loadtest/hpa-run.sh sizing                          # 20/40/60/80 VUs, 2 min each
set -uo pipefail
cd "$(dirname "$0")/.."

: "${CLERK_SECRET_KEY:?set CLERK_SECRET_KEY}"
LABEL=${1:?usage: hpa-run.sh <label>}
NS=${NS:-larper}
OUT=loadtest/results/hpa-$LABEL-$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"
K6=${K6:-$(command -v k6 || command -v k6.exe)}
[[ -n "$K6" ]] || { echo "k6 not found (set K6=path)"; exit 1; }

# Settings under test, for the report header.
kubectl -n "$NS" get deploy api -o jsonpath='{.spec.template.spec.containers[0].resources}' >"$OUT/resources.json"
kubectl -n "$NS" get hpa api -o json >"$OUT/hpa.json" 2>/dev/null || echo '{}' >"$OUT/hpa.json"

# epoch, replicas, desired, HPA utilisation %, per-pod CPU (m) from metrics-server
record() {
  while :; do
    local t r d u cpu
    t=$(date +%s)
    read -r r d u < <(kubectl -n "$NS" get hpa api \
      -o jsonpath='{.status.currentReplicas} {.status.desiredReplicas} {.status.currentMetrics[0].resource.current.averageUtilization}' 2>/dev/null)
    [[ -z "${r:-}" ]] && r=$(kubectl -n "$NS" get deploy api -o jsonpath='{.status.readyReplicas}')
    cpu=$(kubectl -n "$NS" top pods -l app=api --no-headers 2>/dev/null | awk '{gsub("m","",$2); printf "%s%s", sep, $2; sep=","}')
    printf '%s\t%s\t%s\t%s\t%s\n' "$t" "${r:-}" "${d:-}" "${u:-}" "$cpu" >>"$OUT/hpa.tsv"
    sleep 5
  done
}
record &
REC=$!
trap 'kill $REC 2>/dev/null' EXIT

"$K6" run --quiet --out "csv=$OUT/k6.csv" --summary-export "$OUT/summary.json" loadtest/quests.js >"$OUT/k6.log" 2>&1
echo "k6 exit $?" >>"$OUT/k6.log"
sleep 10
kill $REC 2>/dev/null

node loadtest/hpa-report.js "$OUT" | tee "$OUT/report.md"
