#!/usr/bin/env bash
# Retry launching an Always Free Ampere A1 instance (2 OCPU / 12 GB) until Oracle has
# capacity, then KEEP it: it becomes the single-node k3s host (infra/oci-k3s).
#
#   scripts/oci-capacity-probe.sh                 # every 10 min until success
#   INTERVAL=300 OCPUS=1 MEMORY_GB=6 scripts/oci-capacity-probe.sh
#   NTFY_TOPIC=some-long-random-name scripts/oci-capacity-probe.sh   # also push to phone (ntfy.sh)
#
# Needs a configured OCI CLI (~/.oci/config, profile DEFAULT). Everything it creates
# is Always Free:
#   - VCN larper-k3s (10.99.0.0/16) with an internet gateway and a route table
#   - security list: inbound TCP 22 from anywhere, plus ICMP 3/4 (path-MTU discovery,
#     not a port); all outbound
#   - public subnet 10.99.1.0/24
#   - the instance: VM.Standard.A1.Flex, Ubuntu 24.04, 50 GB boot volume, ephemeral
#     public IP, SSH key ~/.ssh/larper_oci (generated if missing)
# It also deletes the private network left by the old terminate-on-success probe
# (VCN larper-a1-probe). Safe to re-run: if the instance already exists it reports
# its address and exits without launching a second one.
#
# Stops (without retrying) on any error other than "out of capacity" or rate
# limiting, so a config or quota problem never loops for days.
set -uo pipefail
export SUPPRESS_LABEL_WARNING=True

INTERVAL=${INTERVAL:-600}
OCPUS=${OCPUS:-2}
MEMORY_GB=${MEMORY_GB:-12}
NAME=larper-k3s
OLD_NAME=larper-a1-probe
SSH_KEY=${SSH_KEY:-$HOME/.ssh/larper_oci}
LOG=${LOG:-$HOME/larper-oci-probe.log}

log() { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }

notify() { # title, message (no single quotes: they end the PowerShell string)
  log "NOTIFY: $1: $2"
  powershell.exe -NoProfile -Command "
    Add-Type -AssemblyName System.Windows.Forms
    \$n = New-Object System.Windows.Forms.NotifyIcon
    \$n.Icon = [System.Drawing.SystemIcons]::Information
    \$n.Visible = \$true
    \$n.ShowBalloonTip(60000, '$1', '$2', 'Info')
    Start-Sleep 60; \$n.Dispose()" >/dev/null 2>&1 &
  if [[ -n "${NTFY_TOPIC:-}" ]]; then
    curl -s -H "Title: $1" -d "$2" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null || true
  fi
}

# Instance ids named $NAME in the given lifecycle states (JMESPath list literal).
instances_in() {
  oci compute instance list --compartment-id "$TENANCY" --display-name "$NAME" \
    --query "data[?contains(\`$1\`, \"lifecycle-state\")].id" --raw-output 2>/dev/null \
    | grep -o 'ocid1\.instance[^"]*'
}

die() {
  log "STOPPED: $*"
  # Clean up a half-finished launch, but never touch a RUNNING/STOPPED instance:
  # that is the kept k3s host.
  if [[ -n "${TENANCY:-}" ]]; then
    for id in $(instances_in '["PROVISIONING","STARTING"]'); do
      log "terminating half-launched instance $id"
      oci compute instance terminate --instance-id "$id" --preserve-boot-volume false --force >/dev/null 2>&1
    done
  fi
  notify "Larper OCI probe stopped" "$*"
  exit 1
}

# Echo the id of the first AVAILABLE resource from a list command, or nothing.
first_id() { "$@" --lifecycle-state AVAILABLE --query 'data[0].id' --raw-output 2>/dev/null | grep -o 'ocid1\.[^"]*'; }

public_ip() {
  oci compute instance list-vnics --instance-id "$1" --query 'data[0]."public-ip"' --raw-output 2>/dev/null
}

report() { # instance id, attempt count
  local ip
  ip=$(public_ip "$1")
  echo "INSTANCE_ID=$1" >"$HOME/larper-oci-instance.env"
  echo "PUBLIC_IP=$ip" >>"$HOME/larper-oci-instance.env"
  log "instance $1 at $ip (saved to ~/larper-oci-instance.env); ssh -i ~/.ssh/larper_oci ubuntu@$ip"
  notify "Larper: Oracle A1 instance is up" "$OCPUS OCPU / $MEMORY_GB GB at $ip after $2 attempt(s). ssh -i ~/.ssh/larper_oci ubuntu@$ip"
}

command -v oci >/dev/null || die "oci CLI not found"
TENANCY=$(awk -F' *= *' '/^\[DEFAULT\]/{d=1;next} /^\[/{d=0} d&&$1=="tenancy"{print $2}' ~/.oci/config)
[[ -n "$TENANCY" ]] || die "no tenancy in ~/.oci/config [DEFAULT]"

if [[ ! -f "$SSH_KEY.pub" ]]; then
  mkdir -p "$(dirname "$SSH_KEY")" && chmod 700 "$(dirname "$SSH_KEY")"
  ssh-keygen -q -t ed25519 -N "" -C larper-oci -f "$SSH_KEY" || die "can't generate $SSH_KEY"
  log "generated SSH key $SSH_KEY"
fi
# The CLI is a Windows program under Git Bash: hand it a Windows path.
PUBKEY_FILE=$(cygpath -w "$SSH_KEY.pub" 2>/dev/null || echo "$SSH_KEY.pub")

existing=$(instances_in '["PROVISIONING","STARTING","RUNNING","STOPPING","STOPPED"]' | head -1)
if [[ -n "$existing" ]]; then
  report "$existing" 0
  exit 0
fi

# Old probe network (private subnet, no gateway): delete it, it is never used again.
OLD_VCN=$(first_id oci network vcn list --compartment-id "$TENANCY" --display-name "$OLD_NAME")
if [[ -n "$OLD_VCN" ]]; then
  for s in $(oci network subnet list --compartment-id "$TENANCY" --vcn-id "$OLD_VCN" \
               --query 'data[].id' --raw-output 2>/dev/null | grep -o 'ocid1\.subnet[^"]*'); do
    oci network subnet delete --subnet-id "$s" --force --wait-for-state TERMINATED >/dev/null 2>&1
  done
  oci network vcn delete --vcn-id "$OLD_VCN" --force --wait-for-state TERMINATED >/dev/null 2>&1 \
    && log "deleted old probe VCN $OLD_NAME" || log "couldn't delete old VCN $OLD_NAME (harmless; delete it in the console)"
fi

AD=$(oci iam availability-domain list --compartment-id "$TENANCY" --query 'data[0].name' --raw-output) \
  || die "can't list availability domains (is the API key uploaded?)"
IMAGE=$(oci compute image list --compartment-id "$TENANCY" --operating-system "Canonical Ubuntu" \
          --operating-system-version "24.04" --shape VM.Standard.A1.Flex \
          --sort-by TIMECREATED --sort-order DESC --limit 1 --query 'data[0].id' --raw-output) \
  || die "can't find an Ubuntu 24.04 aarch64 image"

# Public network: VCN -> internet gateway -> route table, SSH-only security list.
VCN=$(first_id oci network vcn list --compartment-id "$TENANCY" --display-name "$NAME")
if [[ -z "$VCN" ]]; then
  VCN=$(oci network vcn create --compartment-id "$TENANCY" --display-name "$NAME" \
          --cidr-blocks '["10.99.0.0/16"]' --dns-label larper \
          --wait-for-state AVAILABLE --query 'data.id' --raw-output) || die "can't create VCN $NAME"
  log "created VCN $VCN"
fi
IGW=$(first_id oci network internet-gateway list --compartment-id "$TENANCY" --vcn-id "$VCN" --display-name "$NAME")
if [[ -z "$IGW" ]]; then
  IGW=$(oci network internet-gateway create --compartment-id "$TENANCY" --vcn-id "$VCN" --display-name "$NAME" \
          --is-enabled true --wait-for-state AVAILABLE --query 'data.id' --raw-output) \
    || die "can't create the internet gateway"
fi
RT=$(first_id oci network route-table list --compartment-id "$TENANCY" --vcn-id "$VCN" --display-name "$NAME")
if [[ -z "$RT" ]]; then
  RT=$(oci network route-table create --compartment-id "$TENANCY" --vcn-id "$VCN" --display-name "$NAME" \
         --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]" \
         --wait-for-state AVAILABLE --query 'data.id' --raw-output) || die "can't create the route table"
fi
SL=$(first_id oci network security-list list --compartment-id "$TENANCY" --vcn-id "$VCN" --display-name "$NAME")
if [[ -z "$SL" ]]; then
  SL=$(oci network security-list create --compartment-id "$TENANCY" --vcn-id "$VCN" --display-name "$NAME" \
         --ingress-security-rules '[
           {"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":22,"max":22}}},
           {"source":"0.0.0.0/0","protocol":"1","isStateless":false,"icmpOptions":{"type":3,"code":4}}]' \
         --egress-security-rules '[{"destination":"0.0.0.0/0","protocol":"all","isStateless":false}]' \
         --wait-for-state AVAILABLE --query 'data.id' --raw-output) || die "can't create the security list"
fi
SUBNET=$(first_id oci network subnet list --compartment-id "$TENANCY" --vcn-id "$VCN" --display-name "$NAME")
if [[ -z "$SUBNET" ]]; then
  SUBNET=$(oci network subnet create --compartment-id "$TENANCY" --vcn-id "$VCN" --display-name "$NAME" \
             --cidr-block 10.99.1.0/24 --dns-label k3s --prohibit-public-ip-on-vnic false \
             --route-table-id "$RT" --security-list-ids "[\"$SL\"]" \
             --wait-for-state AVAILABLE --query 'data.id' --raw-output) || die "can't create the public subnet"
  log "created public subnet $SUBNET"
fi

log "probing $OCPUS OCPU / $MEMORY_GB GB in $AD every ${INTERVAL}s (log: $LOG)"
attempt=0
while true; do
  attempt=$((attempt + 1))
  out=$(oci compute instance launch --compartment-id "$TENANCY" --availability-domain "$AD" \
          --display-name "$NAME" --shape VM.Standard.A1.Flex \
          --shape-config "{\"ocpus\": $OCPUS, \"memoryInGBs\": $MEMORY_GB}" \
          --image-id "$IMAGE" --subnet-id "$SUBNET" --assign-public-ip true \
          --ssh-authorized-keys-file "$PUBKEY_FILE" \
          --boot-volume-size-in-gbs 50 \
          --wait-for-state RUNNING --wait-for-state TERMINATED --max-wait-seconds 900 \
          --query 'data.{id:id,state:"lifecycle-state"}' 2>&1)
  rc=$?

  if [[ $rc -eq 0 ]] && grep -q '"RUNNING"' <<<"$out"; then
    id=$(grep -o 'ocid1\.instance[^"]*' <<<"$out" | head -1)
    log "attempt $attempt: CAPACITY FOUND, instance $id is RUNNING; keeping it"
    report "$id" "$attempt"
    exit 0
  fi

  if grep -qi 'out of host capacity\|OutOfCapacity\|out of capacity' <<<"$out"; then
    log "attempt $attempt: out of capacity; next try in ${INTERVAL}s"
  elif grep -qi 'TooManyRequests\|429' <<<"$out"; then
    log "attempt $attempt: rate limited; next try in ${INTERVAL}s"
  elif grep -q '"TERMINATED"' <<<"$out"; then
    log "attempt $attempt: instance was accepted then terminated (capacity); next try in ${INTERVAL}s"
  else
    die "attempt $attempt: unexpected error: $(tr '\n' ' ' <<<"$out" | cut -c1-400)"
  fi
  sleep "$INTERVAL"
done
