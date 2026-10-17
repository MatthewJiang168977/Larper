#!/usr/bin/env bash
# Rehearses scripts/oci-up.sh on a local stand-in for the Oracle A1 VM, before a real
# one exists: a privileged Ubuntu 24.04 container booting systemd with Oracle's stock
# iptables rules (Dockerfile), and SeaweedFS's S3 API in place of Object Storage.
#
#   infra/oci-k3s/test/run.sh up        # fake VM + S3 stand-in, oci-up.sh, then checks
#   infra/oci-k3s/test/run.sh check     # re-run the checks
#   infra/oci-k3s/test/run.sh reboot    # restart the VM, then check it came back
#   infra/oci-k3s/test/run.sh k3s-restart  # firewall re-apply + k3s restart under requests, then check
#   infra/oci-k3s/test/run.sh restore   # replace the VM, restore Postgres from the S3 stand-in
#   infra/oci-k3s/test/run.sh down      # remove everything
#
# Differences from Oracle: amd64 images (k3s and Redpanda don't run reliably under
# QEMU; the arm64 builds are checked separately), Docker's network instead of the VCN,
# and http SeaweedFS instead of Oracle's S3 endpoint. Jobs still go through the real SQS
# queue (infra/terraform/aws, free tier).
set -euo pipefail
cd "$(dirname "$0")/../../.."

STATE=$HOME/.larper-oci-test
NET=larper-oci-test
SUBNET=172.31.250.0/24
S3_IP=172.31.250.10
VM_IP=172.31.250.20
VM=larper-oci-vm
S3=larper-oci-s3
S3_IMAGE=chrislusf/seaweedfs:3.97
AWS_IMAGE=amazon/aws-cli:2.27.50
SSH_PORT=2222
TUNNEL_PORT=16444
BUCKET=larper-pg-backups

log() { echo "==> $*"; }
fail() { echo "FAIL: $*" >&2; FAILED=1; }
ok() { echo "  ok: $*"; }
FAILED=0
TUNNEL=
PF=
SSH_OPTS=(-i "$STATE/id_ed25519" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$STATE/known_hosts"
  -o Port=$SSH_PORT -o ConnectTimeout=10 -o BatchMode=yes)
vm() { ssh "${SSH_OPTS[@]}" ubuntu@127.0.0.1 "$@"; }
export MSYS_NO_PATHCONV=1 # Git Bash: keep /data, /readyz etc. as written
winpath() { cygpath -w "$1" 2>/dev/null || echo "$1"; }
aws() { # AWS CLI on the test network, signed with the stand-in's key
  # shellcheck disable=SC1091
  (source "$STATE/s3.env"; docker run --rm --network "$NET" -e AWS_ACCESS_KEY_ID="$ACCESS_KEY_ID"     -e AWS_SECRET_ACCESS_KEY="$ACCESS_SECRET_KEY" -e AWS_DEFAULT_REGION="$REGION"     "$AWS_IMAGE" --endpoint-url "http://$S3_IP:9000" "$@")
}

state() {
  mkdir -p "$STATE"
  [[ -f $STATE/id_ed25519 ]] || ssh-keygen -q -t ed25519 -N '' -C larper-oci-test -f "$STATE/id_ed25519"
  if [[ ! -s $STATE/s3.env ]]; then
    (umask 077; printf 'ACCESS_KEY_ID=larpertest\nACCESS_SECRET_KEY=%s\nREGION=us-east-1\n' \
      "$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" >"$STATE/s3.env")
  fi
  echo "PUBLIC_IP=127.0.0.1" >"$STATE/instance.env"
}

s3_up() {
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create --subnet "$SUBNET" "$NET" >/dev/null
  if ! docker container inspect "$S3" >/dev/null 2>&1; then
    log "SeaweedFS S3 at $S3_IP (stands in for Object Storage)"
    # shellcheck disable=SC1091
    source "$STATE/s3.env"
    printf '{"identities":[{"name":"cnpg","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin","Read","List","Tagging","Write"]}]}'       "$ACCESS_KEY_ID" "$ACCESS_SECRET_KEY" >"$STATE/s3.json"
    docker create --name "$S3" --network "$NET" --ip "$S3_IP" -v larper-oci-s3:/data "$S3_IMAGE"       server -dir=/data -s3 -s3.port=9000 -s3.config=/etc/s3.json >/dev/null
    docker cp "$(winpath "$STATE/s3.json")" "$S3:/etc/s3.json"
    docker start "$S3" >/dev/null
    for _ in $(seq 1 30); do aws s3 ls >/dev/null 2>&1 && break; sleep 2; done
    aws s3 mb "s3://$BUCKET" >/dev/null
  fi
}

vm_up() {
  if docker container inspect "$VM" >/dev/null 2>&1; then
    log "reusing the stand-in VM (oci-up.sh must be safe to re-run)"
    return
  fi
  log "building the stand-in VM image"
  local ctx
  ctx=$(mktemp -d)
  cp infra/oci-k3s/test/{Dockerfile,oracle-rules.v4,oracle-rules.v6} "$ctx/"
  cp "$STATE/id_ed25519.pub" "$ctx/authorized_keys"
  docker build -q -t larper-oci-vm "$(winpath "$ctx")" >/dev/null
  rm -rf "$ctx"
  log "starting the stand-in VM at $VM_IP (SSH on 127.0.0.1:$SSH_PORT)"
  # k3s's containerd can't use overlayfs on the container's own overlay root: its
  # state lives on volumes, like the VM's boot disk.
  # A private cgroup namespace, like a VM's single cgroup tree. With the host's, the
  # kubelet sees every pod cgroup twice (/kubepods and /docker/<id>/kubepods) and
  # loses track of running containers when k3s restarts.
  docker run -d --name "$VM" --hostname larper-k3s --privileged --cgroupns=private \
    --tmpfs /run --tmpfs /run/lock \
    -v larper-oci-vm-rancher:/var/lib/rancher -v larper-oci-vm-kubelet:/var/lib/kubelet \
    --memory 12g --cpus 2 --network "$NET" --ip "$VM_IP" -p 127.0.0.1:$SSH_PORT:22 \
    larper-oci-vm >/dev/null
  rm -f "$STATE/known_hosts"
  for _ in $(seq 1 60); do vm true 2>/dev/null && break; sleep 2; done
  vm true || { echo "no SSH to the stand-in VM" >&2; exit 1; }
}

deploy() { # extra env for oci-up.sh, e.g. RESTORE_FROM=pg SERVER_NAME=pg-2
  # oci-up.sh uses ~/.ssh/known_hosts; a new stand-in VM has a new host key.
  ssh-keygen -R "[127.0.0.1]:$SSH_PORT" >/dev/null 2>&1 || true
  log "running scripts/oci-up.sh against the stand-in"
  env OCI_ENV_FILE="$STATE/instance.env" SSH_KEY="$STATE/id_ed25519" SSH_PORT=$SSH_PORT \
    S3_ENV="$STATE/s3.env" KUBECONFIG_OCI="$STATE/kubeconfig.yaml" TUNNEL_PORT=$TUNNEL_PORT \
    IMAGE_PLATFORM=linux/amd64 BACKUP_ENDPOINT_URL="http://$S3_IP:9000" "$@" scripts/oci-up.sh
}

tunnel() {
  ssh "${SSH_OPTS[@]}" -N -o ExitOnForwardFailure=yes -L "$TUNNEL_PORT:127.0.0.1:6443" ubuntu@127.0.0.1 &
  TUNNEL=$!
  trap 'kill $TUNNEL 2>/dev/null; kill $PF 2>/dev/null' EXIT
  export KUBECONFIG
  KUBECONFIG=$(winpath "$STATE/kubeconfig.yaml")
  for _ in $(seq 1 20); do kubectl get --raw /readyz >/dev/null 2>&1 && return; sleep 2; done
  echo "k3s API not reachable through the tunnel" >&2; exit 1
}

psql() { kubectl -n larper exec pg-1 -c postgres -- psql -U postgres -d larper -tAc "$1"; }

check() {
  log "checks"
  # SSH hardening, as sshd actually resolves it (cloud-init's drop-in says yes).
  eff=$(vm "sudo sshd -T" 2>/dev/null)
  grep -qx 'passwordauthentication no' <<<"$eff" && ok "sshd: passwords off" || fail "sshd allows passwords"
  grep -qx 'permitrootlogin no' <<<"$eff" && ok "sshd: no root login" || fail "sshd allows root"
  if ssh -o Port=$SSH_PORT -o UserKnownHostsFile="$STATE/known_hosts" -o PubkeyAuthentication=no \
       -o PreferredAuthentications=password,keyboard-interactive -o BatchMode=yes -o ConnectTimeout=5 \
       ubuntu@127.0.0.1 true 2>"$STATE/pw.err"; then
    fail "password login worked"
  else
    grep -q 'Permission denied (publickey)' "$STATE/pw.err" && ok "password login refused (publickey only)" \
      || fail "password login: unexpected error: $(cat "$STATE/pw.err")"
  fi

  # Firewall, from a neighbour on the VM's network (the VCN list is the other layer).
  vm "systemctl list-timers --all | grep -q larper-fw-rollback" && fail "firewall rollback timer still armed" \
    || ok "firewall rollback disarmed"

  tunnel
  # Traefik's LoadBalancer ports (80/443, via k3s's service load balancer) and its
  # NodePorts are the ones Kubernetes itself opens; the rest are k3s's own.
  nodeports=$(kubectl -n kube-system get svc traefik -o jsonpath='{.spec.ports[*].nodePort}')
  for port in 22 6443 10250 80 443 $nodeports; do
    if docker run --rm --network "$NET" busybox:1.37.0 nc -z -w 3 "$VM_IP" "$port" 2>/dev/null; then
      [[ $port == 22 ]] && ok "port 22 reachable" || fail "port $port reachable from the network"
    else
      [[ $port == 22 ]] && fail "port 22 not reachable" || ok "port $port closed"
    fi
  done
  kubectl get nodes -o wide | sed 's/^/  /'
  notready=$(kubectl get pods -A --no-headers | grep -vE 'Running|Completed' || true)
  [[ -z $notready ]] && ok "all pods Running/Completed" || fail "pods not ready:"$'\n'"$notready"
  kubectl -n kube-system port-forward svc/traefik 18081:80 >/dev/null 2>&1 &
  PF=$!
  sleep 3
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:18081/readyz || true)
  [[ $code == 200 ]] && ok "API /readyz through Traefik: 200" || fail "API /readyz through Traefik: $code"

  # Backups: the immediate base backup and WAL archiving to the object store.
  for _ in $(seq 1 60); do
    phase=$(kubectl -n larper get backup -o jsonpath='{.items[0].status.phase}' 2>/dev/null || true)
    [[ $phase == completed || $phase == failed ]] && break; sleep 5
  done
  [[ $phase == completed ]] && ok "base backup completed" || fail "base backup phase: ${phase:-none}"
  arch=$(kubectl -n larper get cluster pg -o jsonpath='{.status.conditions[?(@.type=="ContinuousArchiving")].status}')
  [[ $arch == True ]] && ok "WAL archiving" || fail "ContinuousArchiving=$arch"
  aws s3 ls --recursive "s3://$BUCKET" | awk '{print $NF}' | cut -d/ -f1-2 | sort | uniq -c | sed 's/^/  /'
}

case ${1:-} in
  up)
    state; s3_up; vm_up; deploy
    check
    log "writing a marker row for the restore test"
    psql "CREATE TABLE IF NOT EXISTS restore_marker (v text); INSERT INTO restore_marker VALUES ('$(date -u +%FT%TZ)');" >/dev/null
    psql "SELECT pg_switch_wal();" >/dev/null # archive it now, not after archive_timeout
    ;;
  check) check ;;
  reboot)
    log "restarting the VM (as after an unattended-upgrades reboot)"
    docker restart "$VM" >/dev/null
    for _ in $(seq 1 60); do vm true 2>/dev/null && break; sleep 2; done
    tunnel
    log "waiting for pods to settle"
    for _ in $(seq 1 60); do
      [[ -z $(kubectl get pods -A --no-headers | grep -vE 'Running|Completed') ]] && break; sleep 5
    done
    kill $TUNNEL; trap - EXIT
    check
    ;;
  k3s-restart)
    # What a firewall change does on the real VM (bootstrap.sh: iptables-restore, which
    # flushes k3s's chains, then restart k3s), and what a k3s upgrade does, on a node
    # with the whole stack running and a request every 0.2 s through Traefik.
    tunnel
    restarts() { kubectl get pods -A --no-headers | awk '{print $1"/"$2, $5}' | sort; }
    restarts >"$STATE/restarts.before"
    # From the VM to its own address (Traefik's port 80 via k3s's service load
    # balancer); the mangle guard doesn't apply to local traffic.
    vm "nohup sh -c 'echo \$\$ >/tmp/readyz.pid; while :; do echo \$(date +%s.%N) \$(curl -s -o /dev/null -m 2 -w %{http_code} http://$VM_IP/readyz); sleep 0.2; done' >/tmp/readyz.log 2>&1 </dev/null &"
    sleep 10
    log "re-applying the firewall and restarting k3s"
    vm "sudo sh -c 'iptables-restore </etc/iptables/rules.v4 && ip6tables-restore </etc/iptables/rules.v6 && systemctl restart k3s'"
    kill $TUNNEL; trap - EXIT
    for _ in $(seq 1 60); do vm "sudo k3s kubectl get --raw /readyz" >/dev/null 2>&1 && break; sleep 2; done
    tunnel
    log "waiting for pods to settle"
    for _ in $(seq 1 60); do
      [[ -z $(kubectl get pods -A --no-headers | grep -vE 'Running|Completed') ]] && break; sleep 5
    done
    sleep 20
    vm 'kill $(cat /tmp/readyz.pid)' || true
    vm "cat /tmp/readyz.log" >"$STATE/readyz.log"
    awk '$2 != 200 {bad++; if (!first) first = $1; last = $1} END {
      printf "  readyz during the restart: %d requests, %d not 200", NR, bad
      if (bad) printf " (from first to last failure: %.1f s)", last - first
      print ""}' "$STATE/readyz.log"
    restarts >"$STATE/restarts.after"
    changed=$(join "$STATE/restarts.before" "$STATE/restarts.after" | awk '$2 != $3 {print "  " $1 ": " $2 " -> " $3}')
    gone=$(comm -3 <(cut -d' ' -f1 "$STATE/restarts.before") <(cut -d' ' -f1 "$STATE/restarts.after") | sed 's/^/  /')
    [[ -z $changed ]] && ok "no container restarted" || echo "  container restarts:"$'\n'"$changed"
    [[ -z $gone ]] || echo "  pods replaced:"$'\n'"$gone"
    vm "sudo iptables -t mangle -S PREROUTING" | grep -q larper && ok "mangle guard present after the restart" \
      || fail "mangle guard missing after the restart"
    kill $TUNNEL; trap - EXIT
    check
    ;;
  restore)
    state
    log "replacing the VM: new container, empty disks"
    expected=$( (tunnel; psql "SELECT v FROM restore_marker") 2>/dev/null || true)
    [[ -n $expected ]] || { echo "no marker row on the current VM (run 'up' first)" >&2; exit 1; }
    # Restore from the folder the lost cluster wrote to, into the next one (pg -> pg-2 -> pg-3).
    from=$( (tunnel; kubectl -n larper get cluster pg -o jsonpath='{.spec.plugins[0].parameters.serverName}') 2>/dev/null)
    from=${from:-pg}
    n=${from#pg}; n=${n#-}; to=pg-$(( ${n:-1} + 1 ))
    log "restoring from $from into $to"
    docker rm -f "$VM" >/dev/null
    docker volume rm larper-oci-vm-rancher larper-oci-vm-kubelet >/dev/null
    vm_up; deploy RESTORE_FROM="$from" SERVER_NAME="$to"
    check
    got=$(psql "SELECT v FROM restore_marker" 2>/dev/null || true)
    [[ $got == "$expected" ]] && ok "restored marker row: $got" || fail "marker row: expected '$expected', got '$got'"
    ;;
  down)
    docker rm -f "$VM" "$S3" >/dev/null 2>&1 || true
    docker volume rm larper-oci-vm-rancher larper-oci-vm-kubelet larper-oci-s3 >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    rm -rf "$STATE"
    log "removed"
    exit 0
    ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
[[ $FAILED == 0 ]] && log "all checks passed" || { log "some checks FAILED"; exit 1; }
