#!/usr/bin/env bash
# Retry launching an Always Free Ampere A1 instance (2 OCPU / 12 GB) until Oracle has
# capacity, then terminate it at once so the free allowance is left for OKE.
#
#   scripts/oci-capacity-probe.sh                 # every 10 min until success
#   INTERVAL=300 OCPUS=1 MEMORY_GB=6 scripts/oci-capacity-probe.sh
#   NTFY_TOPIC=some-long-random-name scripts/oci-capacity-probe.sh   # also push to phone (ntfy.sh)
#
# Needs a configured OCI CLI (~/.oci/config, profile DEFAULT). Everything it creates
# is Always Free: a VCN and a private subnet (no internet gateway, no public IP)
# that it deletes again on success, and the probe instance itself, with a 50 GB
# boot volume that is deleted on termination.
#
# Stops (without retrying) on any error other than "out of capacity" or rate
# limiting, so a config or quota problem never loops for days.
set -uo pipefail

INTERVAL=${INTERVAL:-600}
OCPUS=${OCPUS:-2}
MEMORY_GB=${MEMORY_GB:-12}
NAME=larper-a1-probe
LOG=${LOG:-$HOME/larper-oci-probe.log}

log() { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }

notify() { # title, message
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

die() {
  log "STOPPED: $*"
  # Never leave a probe instance behind, whatever state the launch got to.
  if [[ -n "${TENANCY:-}" ]]; then
    for id in $(oci compute instance list --compartment-id "$TENANCY" --display-name "$NAME" \
                  --query 'data[?"lifecycle-state"!=`TERMINATED`].id' --raw-output 2>/dev/null | grep -o 'ocid1\.instance[^"]*'); do
      log "terminating leftover probe instance $id"
      oci compute instance terminate --instance-id "$id" --preserve-boot-volume false --force >/dev/null 2>&1
    done
  fi
  notify "Larper OCI probe stopped" "$*"
  exit 1
}

command -v oci >/dev/null || die "oci CLI not found"
TENANCY=$(awk -F' *= *' '/^\[DEFAULT\]/{d=1;next} /^\[/{d=0} d&&$1=="tenancy"{print $2}' ~/.oci/config)
[[ -n "$TENANCY" ]] || die "no tenancy in ~/.oci/config [DEFAULT]"

AD=$(oci iam availability-domain list --compartment-id "$TENANCY" --query 'data[0].name' --raw-output) \
  || die "can't list availability domains (is the API key uploaded?)"
IMAGE=$(oci compute image list --compartment-id "$TENANCY" --operating-system "Canonical Ubuntu" \
          --operating-system-version "24.04" --shape VM.Standard.A1.Flex \
          --sort-by TIMECREATED --sort-order DESC --limit 1 --query 'data[0].id' --raw-output) \
  || die "can't find an Ubuntu 24.04 aarch64 image"

# A private network just for the probe (no gateway: the instance never needs to talk).
VCN=$(oci network vcn list --compartment-id "$TENANCY" --display-name "$NAME" \
        --lifecycle-state AVAILABLE --query 'data[0].id' --raw-output 2>/dev/null)
if [[ -z "$VCN" || "$VCN" == "null" ]]; then
  VCN=$(oci network vcn create --compartment-id "$TENANCY" --display-name "$NAME" \
          --cidr-blocks '["10.99.0.0/16"]' --wait-for-state AVAILABLE --query 'data.id' --raw-output) \
    || die "can't create the probe VCN"
fi
SUBNET=$(oci network subnet list --compartment-id "$TENANCY" --vcn-id "$VCN" --display-name "$NAME" \
           --lifecycle-state AVAILABLE --query 'data[0].id' --raw-output 2>/dev/null)
if [[ -z "$SUBNET" || "$SUBNET" == "null" ]]; then
  SUBNET=$(oci network subnet create --compartment-id "$TENANCY" --vcn-id "$VCN" --display-name "$NAME" \
             --cidr-block 10.99.0.0/24 --prohibit-public-ip-on-vnic true \
             --wait-for-state AVAILABLE --query 'data.id' --raw-output) \
    || die "can't create the probe subnet"
fi

cleanup_network() {
  oci network subnet delete --subnet-id "$SUBNET" --force --wait-for-state TERMINATED >/dev/null 2>&1
  oci network vcn delete --vcn-id "$VCN" --force --wait-for-state TERMINATED >/dev/null 2>&1
}

log "probing $OCPUS OCPU / $MEMORY_GB GB in $AD every ${INTERVAL}s (log: $LOG)"
attempt=0
while true; do
  attempt=$((attempt + 1))
  out=$(oci compute instance launch --compartment-id "$TENANCY" --availability-domain "$AD" \
          --display-name "$NAME" --shape VM.Standard.A1.Flex \
          --shape-config "{\"ocpus\": $OCPUS, \"memoryInGBs\": $MEMORY_GB}" \
          --image-id "$IMAGE" --subnet-id "$SUBNET" --assign-public-ip false \
          --boot-volume-size-in-gbs 50 \
          --wait-for-state RUNNING --wait-for-state TERMINATED --max-wait-seconds 900 \
          --query 'data.{id:id,state:"lifecycle-state"}' 2>&1)
  rc=$?

  if [[ $rc -eq 0 ]] && grep -q '"RUNNING"' <<<"$out"; then
    id=$(grep -o 'ocid1\.instance[^"]*' <<<"$out" | head -1)
    log "attempt $attempt: CAPACITY FOUND, instance $id is RUNNING; terminating it"
    if oci compute instance terminate --instance-id "$id" --preserve-boot-volume false --force \
         --wait-for-state TERMINATED --max-wait-seconds 900 >/dev/null 2>&1; then
      log "probe instance terminated (boot volume deleted)"
    else
      notify "Larper OCI probe" "Capacity found but terminate failed: delete $NAME in the console"
      exit 1
    fi
    cleanup_network && log "probe VCN deleted"
    notify "Larper: Oracle A1 capacity found" "$OCPUS OCPU / $MEMORY_GB GB launched and terminated after $attempt attempt(s). Build OKE now."
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
