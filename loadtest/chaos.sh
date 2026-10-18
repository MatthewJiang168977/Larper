#!/usr/bin/env bash
# Failure test: steady k6 load on GET /quests/today while pods are killed on a
# schedule, then a report of what users saw (errors, error window) and whether the
# system healed (pods Ready again, no Kafka lag, no unsent outbox rows).
#
#   CLERK_SECRET_KEY=sk_test_... loadtest/chaos.sh
#   BASE_URL=http://<lb> VUS=60 loadtest/chaos.sh
#
# Schedule (seconds into the run):
#    60  api pod, force-killed (crash: no SIGTERM, no preStop drain)
#   120  api pod, normal delete (graceful: preStop sleep, then SIGTERM)
#   180  taste-worker, ingest-worker, outbox-relay pods, force-killed
#   240  redis, force-killed (the cache: the API should keep answering from Postgres)
#   300  Postgres primary pg-1, force-killed (single instance: expect an outage)
# Results go to loadtest/results/chaos-<time>/ (report.md; the raw CSV is gitignored).
set -uo pipefail
cd "$(dirname "$0")/.."

: "${CLERK_SECRET_KEY:?set CLERK_SECRET_KEY}"
NS=${NS:-larper}
VUS=${VUS:-60}
OUT=loadtest/results/chaos-$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"
# k6 writes the test users' Clerk session IDs into summary.json: strip them however the run ends.
trap 'node loadtest/redact.js "$OUT"' EXIT
EVENTS=$OUT/events.tsv
: >"$EVENTS"

event() { printf '%s\t%s\n' "$(date +%s)" "$*" | tee -a "$EVENTS"; }

# Seconds from now until `cmd` succeeds (polled every second, max 300 s).
time_until() {
  local start=$SECONDS
  until "$@" >/dev/null 2>&1; do
    (( SECONDS - start > 300 )) && { echo "timeout"; return; }
    sleep 1
  done
  echo $((SECONDS - start))
}

# Ready pods for a selector, not counting the one just killed ($pod in kill_and_time),
# reach the deployment's desired count. (The Deployment's own readyReplicas lags a
# force delete by a few seconds, so it can report "ready" before anything replaced it.)
replaced_ready() { # selector, deployment
  local want n
  want=$(kubectl -n "$NS" get deploy "$2" -o jsonpath='{.spec.replicas}')
  n=$(kubectl -n "$NS" get pods -l "$1" -o jsonpath='{range .items[*]}{.metadata.name} {.status.containerStatuses[0].ready}{"\n"}{end}' |
      awk -v k="$pod" '$1 != k && $2 == "true"' | wc -l)
  [[ -n "$want" ]] && (( n >= want ))
}
pod_name() { kubectl -n "$NS" get pods -l "$1" -o jsonpath='{.items[0].metadata.name}'; }

kill_and_time() { # label, how (force|graceful), pod selector, readiness check...
  local label=$1 how=$2 sel=$3; shift 3
  local pod uid; pod=$(pod_name "$sel")
  uid=$(kubectl -n "$NS" get pod "$pod" -o jsonpath='{.metadata.uid}')
  local flags=(--wait=false)
  [[ $how == force ]] && flags+=(--grace-period=0 --force)
  event "KILL $label $pod ($how)"
  kubectl -n "$NS" delete pod "$pod" "${flags[@]}" >/dev/null 2>&1
  ( event "READY $label after $(time_until "$@")s" ) &
}

# CNPG recreates the primary under the same name, so compare UIDs ($uid from kill_and_time).
pg_ready() {
  local now; now=$(kubectl -n "$NS" get pod pg-1 -o jsonpath='{.metadata.uid} {.status.containerStatuses[0].ready}' 2>/dev/null)
  [[ "$now" == *" true" && "${now%% *}" != "$uid" ]]
}

K6=${K6:-$(command -v k6 || command -v k6.exe)}
[[ -n "$K6" ]] || { echo "k6 not found (set K6=path)"; exit 1; }

event "START steady load, $VUS VUs"
SCENARIO=steady VUS=$VUS DURATION=${DURATION:-7m} "$K6" run --quiet \
  --out "csv=$OUT/k6.csv" --summary-export "$OUT/summary.json" loadtest/quests.js \
  >"$OUT/k6.log" 2>&1 &
K6_PID=$!
T0=$SECONDS
at() { local wait=$(( $1 - (SECONDS - T0) )); (( wait > 0 )) && sleep "$wait"; }

at 60;  kill_and_time api-crash force app=api replaced_ready app=api api
at 120; kill_and_time api-graceful graceful app=api replaced_ready app=api api
at 180; kill_and_time taste-worker force app=taste-worker replaced_ready app=taste-worker taste-worker
        kill_and_time ingest-worker force app=ingest-worker replaced_ready app=ingest-worker ingest-worker
        kill_and_time outbox-relay force app=outbox-relay replaced_ready app=outbox-relay outbox-relay
at 240; kill_and_time redis force app=redis replaced_ready app=redis redis
at 300; kill_and_time postgres force cnpg.io/cluster=pg,cnpg.io/instanceRole=primary pg_ready

wait "$K6_PID"; event "END k6 exit $?"
wait # readiness timers

# Healing checks, after the load stops: the pipeline should drain to zero.
lag_zero() { kubectl -n "$NS" exec redpanda-0 -- rpk group describe taste-worker 2>/dev/null | awk '/TOTAL-LAG/{exit !($2==0)}'; }
outbox_empty() { [[ $(kubectl -n "$NS" exec pg-1 -c postgres -- psql -U postgres -d larper -Atc 'select count(*) from outbox where sent_at is null' 2>/dev/null) == 0 ]]; }
event "HEAL kafka-lag-zero after $(time_until lag_zero)s"
event "HEAL outbox-drained after $(time_until outbox_empty)s"
event "HEAL all-deployments $(kubectl -n "$NS" get deploy -o jsonpath='{range .items[*]}{.metadata.name}={.status.readyReplicas}/{.spec.replicas} {end}')"

node loadtest/chaos-report.js "$OUT" | tee "$OUT/report.md"
