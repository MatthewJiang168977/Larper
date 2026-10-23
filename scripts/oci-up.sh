#!/usr/bin/env bash
# Deploy the stack to the Oracle A1 VM as single-node k3s (Always Free). Safe to re-run.
#
#   scripts/oci-up.sh                        # first deploy, or update
#   RESTORE_FROM=pg scripts/oci-up.sh        # new VM: restore Postgres from backup
#                                            # (infra/oci-k3s/README.md, "rebuild")
#   MONITORING=1 scripts/oci-up.sh           # also Prometheus + Grafana (~0.8 GiB more)
#   scripts/oci-up.sh --close                # back to SSH-only, fast (no images or operators)
#
# Public (infra/oci-k3s/README.md, "Going public"): set PUBLIC_HOST, in the environment
# or in PUBLIC_ENV (default ~/.oci/larper-public.env, never committed):
#   PUBLIC_HOST=api.example.com     # the API's name; its A record points at the VM
#   WEB_ORIGIN=https://example.com  # the web app (CORS and Clerk's authorized parties)
#   ACME_ENV=staging                # staging | production | off (no certificate)
#   ACME_EMAIL=you@example.com      # optional ACME contact
# Then ports 80 and 443 open in the VCN security list and the VM's firewall, and the
# API answers at https://$PUBLIC_HOST. Without PUBLIC_HOST both are SSH-only.
#   SECURITY_LIST=open|closed|skip  # override the security list: e.g. closed to deploy
#                                   # everything but the cloud edge; skip for the stand-in
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
CHECK_ENV=${CHECK_ENV:-$HOME/.oci/larper-backup-check.env} # the backup check's ping URL
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
CLOSE=0
[[ ${1:-} == --close ]] && CLOSE=1

log() { echo "==> $*"; }
winpath() { cygpath -w "$1" 2>/dev/null || echo "$1"; } # kubectl, helm, oci: Windows programs under Git Bash

# Public settings: the environment wins over PUBLIC_ENV.
PUBLIC_ENV=${PUBLIC_ENV:-$HOME/.oci/larper-public.env}
if [[ -f $PUBLIC_ENV && $CLOSE == 0 ]]; then
  while IFS='=' read -r k v; do
    v=${v%$'\r'}
    case $k in PUBLIC_HOST | WEB_ORIGIN | ACME_ENV | ACME_EMAIL) [[ -n ${!k:-} ]] || printf -v "$k" '%s' "$v" ;; esac
  done < <(grep -E '^[A-Z_]+=' "$PUBLIC_ENV")
fi
PUBLIC_HOST=${PUBLIC_HOST:-}
[[ $CLOSE == 1 ]] && PUBLIC_HOST=
WEB_ORIGIN=${WEB_ORIGIN:-}
ACME_ENV=${ACME_ENV:-staging}
ACME_EMAIL=${ACME_EMAIL:-}
PUBLIC=0
if [[ -n $PUBLIC_HOST ]]; then
  PUBLIC=1
  [[ $PUBLIC_HOST =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
    || { echo "PUBLIC_HOST must be a hostname, e.g. api.example.com" >&2; exit 1; }
  [[ $WEB_ORIGIN =~ ^https://[a-z0-9.-]+(:[0-9]+)?$ ]] \
    || { echo "PUBLIC_HOST needs WEB_ORIGIN, the web app's https:// origin (CORS, Clerk)" >&2; exit 1; }
  [[ $ACME_ENV =~ ^(staging|production|off)$ ]] || { echo "ACME_ENV must be staging, production or off" >&2; exit 1; }
fi
SECURITY_LIST=${SECURITY_LIST:-$([[ $PUBLIC == 1 ]] && echo open || echo closed)}
[[ $SECURITY_LIST =~ ^(open|closed|skip)$ ]] || { echo "SECURITY_LIST must be open, closed or skip" >&2; exit 1; }

# The VCN security list larper-k3s (scripts/oci-capacity-probe.sh made it): its ingress
# rules exactly as wanted. "closed": TCP 22 and ICMP 3/4 (path-MTU discovery), as the
# probe made them. "open": also TCP 80 and 443. An update replaces the whole list, so
# the full set is written; nothing happens if it's already right. Egress is untouched.
security_list() { # open|closed
  local want=$1 tenancy vcn sl cur new
  tenancy=$(awk -F' *= *' '/^\[DEFAULT\]/{d=1;next} /^\[/{d=0} d&&$1=="tenancy"{print $2}' "$OCI_CONFIG")
  vcn=$(oci network vcn list --compartment-id "$tenancy" --display-name larper-k3s --query 'data[0].id' --raw-output)
  sl=$(oci network security-list list --compartment-id "$tenancy" --vcn-id "$vcn" --display-name larper-k3s \
    --query 'data[0].id' --raw-output)
  [[ $sl == ocid1.securitylist.* ]] || { echo "no security list larper-k3s in VCN larper-k3s" >&2; exit 1; }
  new=$(mktemp)
  python - "$want" >"$new" <<'PY'
import json, sys
tcp = lambda p, d=None: {"protocol": "6", "source": "0.0.0.0/0", "isStateless": False,
                         "tcpOptions": {"destinationPortRange": {"min": p, "max": p}}, **({"description": d} if d else {})}
rules = [tcp(22), {"protocol": "1", "source": "0.0.0.0/0", "isStateless": False, "icmpOptions": {"type": 3, "code": 4}}]
if sys.argv[1] == "open":
    rules += [tcp(80, "larper: HTTP (ACME challenge, redirect to HTTPS)"), tcp(443, "larper: HTTPS (Traefik)")]
print(json.dumps(rules))
PY
  cur=$(oci network security-list get --security-list-id "$sl" --query 'data."ingress-security-rules"' --output json)
  # The same rules? (protocol, source, ports or ICMP type/code; descriptions don't count)
  if python -c '
import json, sys
def g(d, *ks):  # nested get; the CLI answers in kebab-case, the file is camelCase
    for k in ks:
        d = (d or {}).get(k)
    return d
def key(r):
    return (str(r["protocol"]), r["source"],
            g(r, "tcpOptions", "destinationPortRange", "min") or g(r, "tcp-options", "destination-port-range", "min"),
            g(r, "icmpOptions", "type") if "icmpOptions" in r else g(r, "icmp-options", "type"),
            g(r, "icmpOptions", "code") if "icmpOptions" in r else g(r, "icmp-options", "code"))
want = sorted(map(key, json.load(open(sys.argv[1]))), key=str)
have = sorted(map(key, json.load(sys.stdin)), key=str)
sys.exit(0 if want == have else 1)' "$(winpath "$new")" <<<"$cur"; then
    log "security list larper-k3s: already $want"
  else
    log "security list larper-k3s: setting $want ($( [[ $want == open ]] && echo 'TCP 22, 80, 443' || echo 'TCP 22' ) and ICMP 3/4 inbound)"
    oci network security-list update --security-list-id "$sl" --ingress-security-rules "file://$(winpath "$new")" \
      --force --wait-for-state AVAILABLE >/dev/null
  fi
  rm -f "$new"
}
[[ -f $ENV_FILE ]] || { echo "no $ENV_FILE: run scripts/oci-capacity-probe.sh (it saves the VM's address)" >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
[[ -n "${PUBLIC_IP:-}" ]] || { echo "no PUBLIC_IP in $ENV_FILE" >&2; exit 1; }
HOST=ubuntu@$PUBLIC_IP
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ConnectTimeout=15 -o Port="$SSH_PORT")
vm() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }

# --- 0. the cloud edge, closing first ----------------------------------------------
# Closing goes first, before anything on the VM changes. Opening goes last (after the
# chart, below), so nothing is reachable before its rate limits and TLS are in place.
[[ $SECURITY_LIST == closed ]] && security_list closed

# --- 1. bootstrap -----------------------------------------------------------------
log "bootstrapping $PUBLIC_IP (PUBLIC=$PUBLIC$( [[ $CLOSE == 1 ]] && echo ', firewall only'))"
scp "${SSH_OPTS[@]}" infra/oci-k3s/bootstrap.sh "$HOST:/tmp/larper-bootstrap.sh"
vm "sudo K3S_VERSION=${K3S_VERSION:-v1.35.5+k3s1} PUBLIC=$PUBLIC FIREWALL_ONLY=$CLOSE bash /tmp/larper-bootstrap.sh"
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
trap 'kill $TUNNEL 2>/dev/null || true' EXIT # under set -e a failing trap would turn exit 0 into 1
# kubectl and helm are Windows programs under Git Bash: give them Windows paths, and
# stop Git Bash rewriting arguments like /readyz into C:/Program Files/Git/readyz.
export MSYS_NO_PATHCONV=1
export KUBECONFIG=$(winpath "$KUBECONFIG_OCI")
# A firewall change restarts k3s (bootstrap.sh); on one core its API server can take a
# couple of minutes to be ready again.
for _ in $(seq 1 90); do kubectl get --raw /readyz >/dev/null 2>&1 && break; sleep 2; done
kubectl get --raw /readyz >/dev/null || { echo "k3s API not reachable through the tunnel" >&2; exit 1; }
# The bootstrap's last act (the firewall) restarts k3s.
kubectl wait node --all --for=condition=Ready --timeout=300s >/dev/null

if [[ $CLOSE == 1 ]]; then
  # The chart as it is, minus the public parts: no host, no TLS, no edge middlewares.
  # Certificates and issuers left behind are harmless (nothing routes to them).
  helm upgrade larper infra/helm/larper -n larper --reuse-values \
    --set public.enabled=false --set-string ingress.host= --wait --timeout 10m >/dev/null
  log "closed: SSH only, at the security list and on the VM"
  exit 0
fi

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
  # The S3 key belongs to larper-ci, whose only policy is objects in this bucket
  # (infra/oci-k3s/README.md, "Cost and access guards"), never to an admin.
  BACKUP_USER=${BACKUP_USER:-larper-ci}
  NS=$(oci os ns get --query data --raw-output)
  if ! oci os bucket get --bucket-name "$BUCKET" >/dev/null 2>&1; then
    log "creating private bucket $BUCKET (Standard tier)"
    oci os bucket create --compartment-id "$TENANCY" --name "$BUCKET" \
      --public-access-type NoPublicAccess --storage-tier Standard >/dev/null
  fi
  if [[ ! -s $S3_ENV ]]; then
    KEY_USER=$(oci iam user list --compartment-id "$TENANCY" --name "$BACKUP_USER" --query 'data[0].id' --raw-output 2>/dev/null || true)
    [[ $KEY_USER == ocid1.user.* ]] \
      || { echo "no OCI user $BACKUP_USER: create it first (infra/oci-k3s/README.md, \"Cost and access guards\")" >&2; exit 1; }
    # An S3-compatible key (OCI calls it a Customer Secret Key; 2 per user). The secret
    # is shown once: it goes straight into $S3_ENV (mode 600), never to the terminal.
    log "creating the S3 key for CNPG backups (saved to $S3_ENV)"
    umask 077
    oci iam customer-secret-key create --user-id "$KEY_USER" --display-name larper-pg-backup \
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
# The backup check's dead-man's switch (healthchecks.io ping URL, one line: pingURL=...).
if [[ -s $CHECK_ENV ]]; then
  kubectl -n larper create secret generic backup-check --from-env-file="$(winpath "$CHECK_ENV")" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
else
  log "no $CHECK_ENV: the backup check will run but alert nobody (infra/oci-k3s/README.md, \"Backup check\")"
fi

# The demo account (values-oci.yaml demo.enabled; infra/oci-k3s/README.md, "The public
# demo"): the Clerk secret key, for "Try the demo" sign-in tokens and the nightly reset,
# and the demo user's id, which scripts/demo-account.sh create writes to DEMO_ENV.
# Without both, the demo is off: /demo/sign-in answers 404 and nothing resets.
DEMO_ENV=${DEMO_ENV:-$HOME/.oci/larper-demo.env}
demo=(--set demo.enabled=false)
demo_user=$(grep -E '^DEMO_USER_ID=' "$DEMO_ENV" 2>/dev/null | cut -d= -f2- | tr -d '\r' || true)
clerk_key=$(grep -E '^CLERK_SECRET_KEY=' apps/web/.env.local 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'\r ' || true)
if [[ $demo_user =~ ^user_[A-Za-z0-9]+$ && -n $clerk_key ]]; then
  kubectl -n larper create secret generic clerk-demo \
    --from-literal=secretKey="$clerk_key" --from-literal=userId="$demo_user" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  demo=()
else
  log "no demo account (DEMO_USER_ID in $DEMO_ENV, CLERK_SECRET_KEY in apps/web/.env.local): \"Try the demo\" is off"
fi

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

# Public: the API's name, its certificate, and who may call it from a browser.
public=(--set public.enabled=false)
if [[ $PUBLIC == 1 ]]; then
  public=(--set public.enabled=true --set-string ingress.host="$PUBLIC_HOST" --set public.acme="$ACME_ENV"
    --set-string public.acmeEmail="$ACME_EMAIL" --set "api.cors.origins={$WEB_ORIGIN}"
    --set-string clerk.authorizedParties="$WEB_ORIGIN")
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
  "${restore[@]}" "${monitoring[@]}" "${public[@]}" "${demo[@]}" \
  --wait --timeout 20m

log "backups"
kubectl -n larper get scheduledbackup,backup 2>/dev/null || true

# --- 6. the cloud edge, opening last ------------------------------------------------
if [[ $SECURITY_LIST == open ]]; then
  security_list open
  if [[ $ACME_ENV != off ]]; then
    # HTTP-01: Let's Encrypt fetches a token from http://$PUBLIC_HOST/.well-known/...
    log "certificate for $PUBLIC_HOST ($ACME_ENV)"
    kubectl -n larper wait certificate/api-tls --for=condition=Ready --timeout=10m \
      || { kubectl -n larper describe certificate api-tls | tail -20; exit 1; }
  fi
fi
# What the internet can reach: the security list decides, whatever the VM allows.
if [[ $PUBLIC == 1 && $SECURITY_LIST == open ]]; then
  reach="SSH, HTTP and HTTPS"
  cat <<EOF

Public at https://$PUBLIC_HOST (certificate: $ACME_ENV).
Only 22, 80 and 443 reach the VM. Close it all: scripts/oci-up.sh --close
EOF
elif [[ $PUBLIC == 1 ]]; then
  reach="only SSH (the security list is $SECURITY_LIST; the VM itself would take 80 and 443)"
  cat <<EOF

Ready for https://$PUBLIC_HOST, but NOT reachable from the internet: security list $SECURITY_LIST.
Open it with: scripts/oci-up.sh   (or SECURITY_LIST=open)
EOF
else
  reach="only SSH"
fi
cat <<EOF

Up on $PUBLIC_IP: $reach reaches it from the internet. kubectl goes through SSH:
  ssh -i ~/.ssh/larper_oci -N -L $TUNNEL_PORT:127.0.0.1:6443 $HOST &
  export KUBECONFIG=$KUBECONFIG_OCI
  kubectl -n kube-system port-forward svc/traefik 8081:80     # app at http://localhost:8081
Backups: kubectl -n larper get backup   (folder s3://$BUCKET/$SERVER_NAME)
First deploy? Load place data: README "Load place data", against this context.
EOF
