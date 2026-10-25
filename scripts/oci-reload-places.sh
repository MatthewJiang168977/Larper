#!/usr/bin/env bash
# Reload a region's places on the Oracle VM, as a one-off Job in the cluster, and report
# how long it took. The Job runs load-places -bbox in the deployed ingest image: the same
# Overture extract the ingest-worker runs per area, for the whole box, then the load
# (tagging, the location check, the upsert, area stats). Idempotent: places are upserted
# by Overture id, nothing is deleted.
#
#   scripts/oci-reload-places.sh                 # NYC: base backup, then the reload
#   scripts/oci-reload-places.sh --no-backup     # skip the backup (a fresh one exists)
#   BBOX=xmin,ymin,xmax,ymax PREFIXES=... scripts/oci-reload-places.sh
#   DRY_RUN=1 scripts/oci-reload-places.sh       # print the manifests, change nothing
#
# It changes the live database: run it only with approval (CLAUDE.md). It prints the
# extract and load times from the Job's log, and its wall time on the VM.
set -euo pipefail
shopt -s inherit_errexit
cd "$(dirname "$0")/.."

ENV_FILE=${OCI_ENV_FILE:-$HOME/larper-oci-instance.env}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/larper_oci}
BBOX=${BBOX:--74.26,40.49,-73.70,40.92} # the NYC region (Helm api.ingestRegion)
PREFIXES=${PREFIXES:-nyc}                # its ZIP prefixes (Helm ingest.postcodePrefixes)
BACKUP=1
for a in "$@"; do
  case $a in
    --no-backup) BACKUP=0 ;;
    *) echo "unknown argument $a (see the top of $0)" >&2; exit 2 ;;
  esac
done
[[ $BBOX =~ ^-?[0-9.]+,-?[0-9.]+,-?[0-9.]+,-?[0-9.]+$ ]] || { echo "BBOX must be xmin,ymin,xmax,ymax" >&2; exit 2; }
[[ $PREFIXES =~ ^[a-z0-9,]*$ ]] || { echo "PREFIXES must be \"nyc\" or a comma list of digits" >&2; exit 2; }

[[ -f $ENV_FILE ]] || { echo "no $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
[[ -n ${PUBLIC_IP:-} ]] || { echo "no PUBLIC_IP in $ENV_FILE" >&2; exit 1; }
vm() { ssh -i "$SSH_KEY" -o ServerAliveInterval=30 -o ConnectTimeout=15 "ubuntu@$PUBLIC_IP" "$@"; }
log() { echo "==> $*"; }
K="sudo k3s kubectl -n larper"
DRY_RUN=${DRY_RUN:-0}
# apply MANIFEST-on-stdin: to the cluster, or printed with DRY_RUN=1.
apply() {
  if [[ $DRY_RUN == 1 ]]; then
    echo "---"
    cat
  else
    vm "$K apply -f -" >/dev/null
  fi
}

# The deployed ingest image and its Overture release: the reload runs exactly what's live.
image=$(vm "$K get deploy ingest-worker -o jsonpath='{.spec.template.spec.containers[0].image}'" | tr -d '\r')
release=$(vm "$K get deploy ingest-worker -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name==\"OVERTURE_RELEASE\")].value}'" | tr -d '\r')
[[ $image == *larper-ingest:* && $image != *-dirty ]] || { echo "unexpected ingest image '$image'" >&2; exit 1; }
[[ $release =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+$ ]] || { echo "unexpected Overture release '$release'" >&2; exit 1; }
log "image $image, release $release, bbox $BBOX, prefixes ${PREFIXES:-none}"

stamp=$(date -u +%Y%m%dt%H%M%S)
if [[ $BACKUP == 1 ]]; then
  b=pg-before-reload-$stamp
  log "base backup $b"
  apply <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata: { name: $b }
spec: { cluster: { name: pg }, method: plugin, pluginConfiguration: { name: barman-cloud.cloudnative-pg.io } }
EOF
  [[ $DRY_RUN == 1 ]] || vm "$K wait backup/$b --for=jsonpath='{.status.phase}'=completed --timeout=15m" >/dev/null \
    || { echo "the backup didn't complete; not reloading" >&2; exit 1; }
  [[ $DRY_RUN == 1 ]] || log "backup completed"
fi

job=load-places-$stamp
log "job $job"
apply <<EOF
apiVersion: batch/v1
kind: Job
metadata: { name: $job, labels: { app: load-places } }
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 3600
  ttlSecondsAfterFinished: 604800
  template:
    metadata: { labels: { app: load-places } }
    spec:
      restartPolicy: Never
      containers:
        - name: load-places
          image: $image
          imagePullPolicy: IfNotPresent
          command: [/usr/local/bin/load-places, -bbox, "$BBOX", -release, "$release", -postcode-prefixes, "$PREFIXES"]
          env:
            - name: DB_USER
              valueFrom: { secretKeyRef: { name: pg-ingest, key: username } }
            - name: DB_PASSWORD
              valueFrom: { secretKeyRef: { name: pg-ingest, key: password } }
            - { name: DATABASE_URL, value: "postgresql://\$(DB_USER):\$(DB_PASSWORD)@pg-rw.larper:5432/larper?pool_max_conns=4" }
            - { name: DUCKDB_MEMORY_LIMIT, value: 2GB }
            - { name: DUCKDB_THREADS, value: "2" }
          resources:
            requests: { cpu: 500m, memory: 1Gi }
            limits: { memory: 3Gi }
EOF
[[ $DRY_RUN == 1 ]] && { log "dry run: nothing applied"; exit 0; }
t0=$SECONDS
vm "$K wait job/$job --for=condition=complete --timeout=60m" >/dev/null &
waiter=$!
# Fail fast if the Job fails instead of waiting out the timeout.
while kill -0 $waiter 2>/dev/null; do
  if [[ $(vm "$K get job/$job -o jsonpath='{.status.failed}'" | tr -d '\r') == 1 ]]; then
    kill $waiter 2>/dev/null || true
    vm "$K logs job/$job --tail=30" >&2 || true
    echo "the reload failed (job $job)" >&2
    exit 1
  fi
  sleep 10
done
wait $waiter
log "completed in $((SECONDS - t0)) s (wall time on the VM, including the image start)"
vm "$K logs job/$job" | tr -d '\r' | grep -E '"msg":"(extracted|done)"' || true
vm "$K get job/$job -o jsonpath='{.status.startTime} -> {.status.completionTime}{\"\n\"}'"
