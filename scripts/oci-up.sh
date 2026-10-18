#!/usr/bin/env bash
# Deploy the stack to the Oracle A1 VM as single-node k3s (Always Free). Safe to re-run.
#
#   scripts/oci-up.sh                        # first deploy, or update
#   RESTORE_FROM=pg scripts/oci-up.sh        # new VM: restore Postgres from backup
#                                            # (infra/oci-k3s/README.md, "rebuild")
#   MONITORING=1 scripts/oci-up.sh           # also Prometheus + Grafana (~0.8 GiB more)
#
# Needs: ~/larper-oci-instance.env (scripts/oci-capacity-probe.sh writes it), the SSH
# key ~/.ssh/larper_oci, the OCI CLI, docker buildx (builder larper-multi), helm,
# kubectl, and infra/terraform/aws applied (the SQS credentials).
#
# What it does:
#   1. runs infra/oci-k3s/bootstrap.sh on the VM (updates, SSH, firewall, k3s), then
#      confirms the firewall over a new SSH connection (otherwise it rolls back)
#   2. opens an SSH tunnel to the k3s API (6443 stays closed to the internet)
#   3. builds arm64 images and imports them into k3s (no registry)
#   4. Object Storage: bucket larper-pg-backups + an S3 key for CNPG (Always Free:
#      20 GB, 50k requests/month; see the README for the numbers)
#   5. installs cert-manager, CloudNativePG + its Barman Cloud plugin, then the larper
#      chart with values-oci.yaml + values-demo.yaml (the VM is 1 OCPU / 6 GB);
#      monitoring only with MONITORING=1
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=${OCI_ENV_FILE:-$HOME/larper-oci-instance.env}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/larper_oci}
S3_ENV=${S3_ENV:-$HOME/.oci/larper-pg-backup-s3.env} # the CNPG backup key; needed again to restore
KUBECONFIG_OCI=${KUBECONFIG_OCI:-$HOME/.kube/larper-oci.yaml}
TUNNEL_PORT=${TUNNEL_PORT:-16443}
REGION=${OCI_REGION:-us-sanjose-1}
BUCKET=larper-pg-backups
CNPG_CHART=0.29.1           # CloudNativePG 1.30.1
BARMAN_CHART=0.8.1          # plugin-barman-cloud v0.15.1
CERT_MANAGER_CHART=v1.21.1
MONITORING_CHART=92.2.0
OCI_CONFIG=${OCI_CLI_CONFIG_FILE:-$HOME/.oci/config}
# Overrides for infra/oci-k3s/test/run.sh (a local stand-in VM); leave unset for Oracle.
SSH_PORT=${SSH_PORT:-22}
IMAGE_PLATFORM=${IMAGE_PLATFORM:-linux/arm64}
BACKUP_ENDPOINT_URL=${BACKUP_ENDPOINT_URL:-} # set: skip Object Storage, use this S3 endpoint and $S3_ENV
MONITORING=${MONITORING:-0}

log() { echo "==> $*"; }
[[ -f $ENV_FILE ]] || { echo "no $ENV_FILE: run scripts/oci-capacity-probe.sh (it saves the VM's address)" >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
[[ -n "${PUBLIC_IP:-}" ]] || { echo "no PUBLIC_IP in $ENV_FILE" >&2; exit 1; }
HOST=ubuntu@$PUBLIC_IP
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ConnectTimeout=15 -o Port="$SSH_PORT")
vm() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }

# --- 1. bootstrap -----------------------------------------------------------------
log "bootstrapping $PUBLIC_IP"
scp "${SSH_OPTS[@]}" infra/oci-k3s/bootstrap.sh "$HOST:/tmp/larper-bootstrap.sh"
vm "sudo K3S_VERSION=${K3S_VERSION:-v1.35.5+k3s1} bash /tmp/larper-bootstrap.sh"
# A fresh connection proves SSH survived the firewall change; only then keep it.
if vm "systemctl list-timers --all | grep -q larper-fw-rollback"; then
  vm "sudo systemctl stop larper-fw-rollback.timer" && log "firewall confirmed (rollback cancelled)"
fi

# --- 2. kube API tunnel -----------------------------------------------------------
mkdir -p "$(dirname "$KUBECONFIG_OCI")"
vm "sudo cat /etc/rancher/k3s/k3s.yaml" \
  | sed "s#https://127.0.0.1:6443#https://127.0.0.1:$TUNNEL_PORT#; s#: default\$#: larper-oci#" >"$KUBECONFIG_OCI"
chmod 600 "$KUBECONFIG_OCI"
ssh "${SSH_OPTS[@]}" -N -o ExitOnForwardFailure=yes -L "$TUNNEL_PORT:127.0.0.1:6443" "$HOST" &
TUNNEL=$!
trap 'kill $TUNNEL 2>/dev/null' EXIT
# kubectl and helm are Windows programs under Git Bash: give them Windows paths, and
# stop Git Bash rewriting arguments like /readyz into C:/Program Files/Git/readyz.
export MSYS_NO_PATHCONV=1
winpath() { cygpath -w "$1" 2>/dev/null || echo "$1"; }
export KUBECONFIG=$(winpath "$KUBECONFIG_OCI")
for _ in $(seq 1 20); do kubectl get --raw /readyz >/dev/null 2>&1 && break; sleep 2; done
kubectl get --raw /readyz >/dev/null || { echo "k3s API not reachable through the tunnel" >&2; exit 1; }
# The bootstrap's last act (the firewall) restarts k3s.
kubectl wait node --all --for=condition=Ready --timeout=300s >/dev/null

# --- 3. images --------------------------------------------------------------------
TAG=$(git rev-parse --short HEAD)$(git diff --quiet HEAD || echo -dirty)
REG=larper.local
have=$(vm "sudo k3s ctr -n k8s.io images ls -q" || true)
import() { # image name, tag, docker build args...
  local name=$1 tag=$2; shift 2
  if grep -qx "$REG/$name:$tag" <<<"$have" && [[ $tag != *-dirty ]]; then
    log "$name:$tag already on the node"
    return
  fi
  log "building $name:$tag ($IMAGE_PLATFORM) and importing it into k3s"
  docker buildx build --builder larper-multi --platform "$IMAGE_PLATFORM" --provenance=false \
    -t "$REG/$name:$tag" --output type=docker,dest=- "$@" \
    | vm "sudo k3s ctr -n k8s.io images import -"
}
PG_TAG=$(scripts/pg-tag.sh "$TAG")
import larper-postgres "$PG_TAG" infra/postgres
import larper-migrate "$TAG" db
import larper-workers "$TAG" --target static workers
import larper-ingest "$TAG" --target ingest workers
import larper-api "$TAG" -f apps/api/Dockerfile .

# --- 4. Object Storage for backups ------------------------------------------------
if [[ -n $BACKUP_ENDPOINT_URL ]]; then
  [[ -s $S3_ENV ]] || { echo "BACKUP_ENDPOINT_URL is set but $S3_ENV is empty" >&2; exit 1; }
  ENDPOINT=$BACKUP_ENDPOINT_URL
else
  TENANCY=$(awk -F' *= *' '/^\[DEFAULT\]/{d=1;next} /^\[/{d=0} d&&$1=="tenancy"{print $2}' "$OCI_CONFIG")
  OCI_USER=$(awk -F' *= *' '/^\[DEFAULT\]/{d=1;next} /^\[/{d=0} d&&$1=="user"{print $2}' "$OCI_CONFIG")
  NS=$(oci os ns get --query data --raw-output)
  if ! oci os bucket get --bucket-name "$BUCKET" >/dev/null 2>&1; then
    log "creating private bucket $BUCKET (Standard tier)"
    oci os bucket create --compartment-id "$TENANCY" --name "$BUCKET" \
      --public-access-type NoPublicAccess --storage-tier Standard >/dev/null
  fi
  if [[ ! -s $S3_ENV ]]; then
    # An S3-compatible key (OCI calls it a Customer Secret Key; 2 per user). The secret
    # is shown once: it goes straight into $S3_ENV (mode 600), never to the terminal.
    log "creating the S3 key for CNPG backups (saved to $S3_ENV)"
    umask 077
    oci iam customer-secret-key create --user-id "$OCI_USER" --display-name larper-pg-backup \
      --query 'data.{id:id,key:key}' --output json \
      | python -c 'import json, sys; d = json.load(sys.stdin); print("ACCESS_KEY_ID=" + d["id"]); print("ACCESS_SECRET_KEY=" + d["key"])' >"$S3_ENV"
    echo "REGION=$REGION" >>"$S3_ENV"
  fi
  ENDPOINT="https://$NS.compat.objectstorage.$REGION.oraclecloud.com"
fi
kubectl create namespace larper --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n larper create secret generic pg-backup-s3 --from-env-file="$(winpath "$S3_ENV")" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n larper create secret generic aws-sqs \
  --from-literal=access_key_id="$(terraform -chdir=infra/terraform/aws output -raw access_key_id)" \
  --from-literal=secret_access_key="$(terraform -chdir=infra/terraform/aws output -raw secret_access_key)" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

# --- 5. operators and the app -----------------------------------------------------
helm repo add jetstack https://charts.jetstack.io >/dev/null 2>&1 || true
helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null 2>&1 || true
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update jetstack cnpg prometheus-community >/dev/null
log "cert-manager (for the Barman Cloud plugin's certificates)"
helm upgrade --install cert-manager jetstack/cert-manager --version "$CERT_MANAGER_CHART" \
  -n cert-manager --create-namespace --set crds.enabled=true --wait
log "CloudNativePG + Barman Cloud plugin"
helm upgrade --install cnpg cnpg/cloudnative-pg --version "$CNPG_CHART" -n cnpg-system --create-namespace --wait
helm upgrade --install barman-cloud cnpg/plugin-barman-cloud --version "$BARMAN_CHART" -n cnpg-system --wait
# The demo profile leaves monitoring off: kube-prometheus-stack alone takes ~0.8 GiB.
monitoring=()
if [[ $MONITORING == 1 ]]; then
  log "monitoring"
  helm upgrade --install monitoring prometheus-community/kube-prometheus-stack --version "$MONITORING_CHART" \
    -n monitoring --create-namespace -f infra/monitoring/values.yaml --wait --timeout 10m
  monitoring=(--set monitoring.enabled=true)
fi

# Backups: keep writing where the existing cluster writes. A restore writes to a new
# folder (pg-2, pg-3, ...) so it never mixes with the backup it restores from.
restore=()
current=$(kubectl -n larper get cluster pg -o jsonpath='{.spec.plugins[0].parameters.serverName}' 2>/dev/null || true)
from=$(kubectl -n larper get cluster pg -o jsonpath='{.spec.externalClusters[0].plugin.parameters.serverName}' 2>/dev/null || true)
if [[ -n $current ]]; then
  SERVER_NAME=$current
  [[ -n $from ]] && restore=(--set postgres.restore.enabled=true --set "postgres.restore.fromServerName=$from")
  [[ -n "${RESTORE_FROM:-}" ]] && log "Postgres already exists here; ignoring RESTORE_FROM"
elif [[ -n "${RESTORE_FROM:-}" ]]; then
  SERVER_NAME=${SERVER_NAME:?set SERVER_NAME to a new backup folder, e.g. pg-2 (see the README)}
  [[ $SERVER_NAME != "$RESTORE_FROM" ]] || { echo "SERVER_NAME must differ from RESTORE_FROM" >&2; exit 1; }
  restore=(--set postgres.restore.enabled=true --set "postgres.restore.fromServerName=$RESTORE_FROM")
  log "restoring Postgres from backup folder $RESTORE_FROM; new backups go to $SERVER_NAME"
else
  SERVER_NAME=${SERVER_NAME:-pg}
fi

log "larper"
# A cluster from before the per-service DB roles needs this once (see the script).
scripts/pg-owner-createrole.sh
helm upgrade --install larper infra/helm/larper -n larper -f infra/helm/larper/values-oci.yaml \
  -f infra/helm/larper/values-demo.yaml \
  --set postgres.image="$REG/larper-postgres:$PG_TAG" \
  --set migrate.image="$REG/larper-migrate:$TAG" \
  --set workers.image="$REG/larper-workers:$TAG" \
  --set ingest.image="$REG/larper-ingest:$TAG" \
  --set api.image="$REG/larper-api:$TAG" \
  --set postgres.backup.endpointURL="$ENDPOINT" \
  --set postgres.backup.serverName="$SERVER_NAME" \
  "${restore[@]}" "${monitoring[@]}" \
  --wait --timeout 20m

log "backups"
kubectl -n larper get scheduledbackup,backup 2>/dev/null || true
cat <<EOF

Up on $PUBLIC_IP (only SSH is open). kubectl and the app go through SSH:
  ssh -i ~/.ssh/larper_oci -N -L $TUNNEL_PORT:127.0.0.1:6443 $HOST &
  export KUBECONFIG=$KUBECONFIG_OCI
  kubectl -n kube-system port-forward svc/traefik 8081:80     # app at http://localhost:8081
Backups: kubectl -n larper get backup   (folder s3://$BUCKET/$SERVER_NAME)
First deploy? Load place data: README "Load place data", against this context.
EOF
