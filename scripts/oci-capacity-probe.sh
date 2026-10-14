#!/usr/bin/env bash
# Retry launching an Always Free Ampere A1 instance (2 OCPU / 12 GB) until Oracle has
# capacity, then KEEP it: it becomes the single-node k3s host (infra/oci-k3s).
#
#   scripts/oci-capacity-probe.sh                 # every 10 min until success
#   INTERVAL=300 OCPUS=1 MEMORY_GB=6 scripts/oci-capacity-probe.sh
#   NTFY_TOPIC=some-long-random-name scripts/oci-capacity-probe.sh   # also push to phone (ntfy.sh)
#   ONCE=1 scripts/oci-capacity-probe.sh          # one attempt (GitHub Actions: .github/workflows/oci-probe.yml)
#
# Needs a configured OCI CLI (OCI_CLI_CONFIG_FILE or ~/.oci/config, profile DEFAULT).
# Everything it creates is Always Free:
#   - VCN larper-k3s (10.99.0.0/16) with an internet gateway and a route table
#   - security list: inbound TCP 22 from anywhere, plus ICMP 3/4 (path-MTU discovery,
#     not a port); all outbound
#   - public subnet 10.99.1.0/24
#   - the instance: VM.Standard.A1.Flex, Ubuntu 24.04, 50 GB boot volume, ephemeral
#     public IP, SSH key ~/.ssh/larper_oci (generated if missing; SSH_PUB_FILE overrides)
# It also deletes the private network left by the old terminate-on-success probe
# (VCN larper-a1-probe). Safe to re-run, and safe to run in two places at once: if the
# instance already exists it reports it and exits; if two launches race, the newer
# instance is terminated.
#
# Errors:
#   - out of capacity: retry every INTERVAL, forever
#   - transient (timeout, connection error, HTTP 5xx, 429): retry after RETRY_DELAY,
#     at most MAX_TRANSIENT (5) in a row, then stop
#   - auth / clock skew (401): transient only right after a long gap (> 15 min more
#     than planned between attempts: the laptop slept); otherwise stop
#   - anything else (config, permissions, quota, bad request): stop at once
# Each error is logged in full: HTTP status, code, message, operation, request id.
#
# ONCE=1 makes one attempt and exits 0 unless the error is fatal, writing
# result=launched|exists|no-capacity|transient|fatal (and summary=...) to
# $GITHUB_OUTPUT when set. Under GitHub Actions, output is redacted (OCIDs, IPs,
# the tenancy's AD prefix): the repo and its Actions logs are public.
set -uo pipefail
export SUPPRESS_LABEL_WARNING=True

INTERVAL=${INTERVAL:-600}
RETRY_DELAY=${RETRY_DELAY:-60}
MAX_TRANSIENT=${MAX_TRANSIENT:-5}
LONG_GAP=${LONG_GAP:-900}
OCPUS=${OCPUS:-2}
MEMORY_GB=${MEMORY_GB:-12}
ONCE=${ONCE:-0}
NAME=larper-k3s
OLD_NAME=larper-a1-probe
SSH_KEY=${SSH_KEY:-$HOME/.ssh/larper_oci}
OCI_CONFIG=${OCI_CLI_CONFIG_FILE:-$HOME/.oci/config}
CI=${GITHUB_ACTIONS:-false}
LOG=${LOG:-$HOME/larper-oci-probe.log}

redact() {
  sed -uE 's/ocid1\.[a-z0-9]+\.[a-z0-9-]+\.[a-z0-9-]*\.[a-z0-9]+/ocid1.<redacted>/g
           s/([0-9]{1,3}\.){3}[0-9]{1,3}/<ip>/g
           s/[A-Za-z]{4}:([A-Z]{2}-[A-Z]+-[0-9]+-AD-[0-9])/\1/g'
}
if [[ $CI == true ]]; then
  LOG=${RUNNER_TEMP:-/tmp}/oci-probe.log
  exec > >(redact) 2>&1 # everything this script prints, including the CLI's errors
  REDACT_PID=$!
  trap 'exec >&- 2>&-; wait "$REDACT_PID" 2>/dev/null' EXIT # let the filter flush its last lines
fi

log() { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }

output() { # key, value: step outputs for the workflow (redacted, one line)
  [[ -n "${GITHUB_OUTPUT:-}" ]] && echo "$1=$(printf '%s' "$2" | tr '\n' ' ' | redact | cut -c1-500)" >>"$GITHUB_OUTPUT"
  return 0
}

notify() { # title, message (no single quotes: they end the PowerShell string)
  log "NOTIFY: $1: $2"
  if command -v powershell.exe >/dev/null; then
    powershell.exe -NoProfile -Command "
      Add-Type -AssemblyName System.Windows.Forms
      \$n = New-Object System.Windows.Forms.NotifyIcon
      \$n.Icon = [System.Drawing.SystemIcons]::Information
      \$n.Visible = \$true
      \$n.ShowBalloonTip(60000, '$1', '$2', 'Info')
      Start-Sleep 60; \$n.Dispose()" >/dev/null 2>&1 &
  fi
  if [[ -n "${NTFY_TOPIC:-}" ]]; then
    curl -s -H "Title: $1" -d "$(printf '%s' "$2" | { [[ $CI == true ]] && redact || cat; })" \
      "https://ntfy.sh/$NTFY_TOPIC" >/dev/null || true
  fi
}

# Instance ids named $NAME in the given lifecycle states (JMESPath list literal),
# oldest first.
instances_in() {
  oci compute instance list --compartment-id "$TENANCY" --display-name "$NAME" --sort-by TIMECREATED --sort-order ASC \
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
  output result fatal
  output summary "$*"
  [[ $CI == true ]] || notify "Larper OCI probe stopped" "$*"
  exit 1
}

# The CLI prints "ServiceError:" or "RequestException:" followed by pretty JSON, one
# field per line. Pull out the fields that say what happened (not the tips).
field() { sed -nE "s/^ *\"$1\": (\"([^\"]*)\"|([^\",]*)),?$/\2\3/p" <<<"$2" | head -1; }
describe_error() { # raw CLI output -> one line: kind status code message operation request-id
  local out=$1 kind status code message op req
  kind=$(grep -oE '^(ServiceError|RequestException|[A-Za-z]+Error|[A-Za-z]+Exception)' <<<"$out" | head -1)
  status=$(field status "$out"); code=$(field code "$out"); message=$(field message "$out")
  op=$(field operation_name "$out"); req=$(field opc-request-id "$out")
  if [[ -z "$status$code$message" ]]; then
    # Not the usual shape: keep the whole thing, minus the tips.
    grep -v -E '"(logging_tips|troubleshooting_tips)"' <<<"$out" | tr -s ' \n' ' ' | cut -c1-1500
    return
  fi
  echo "${kind:-error}: status=${status:-none} code=${code:-none} message=\"${message:-none}\" operation=${op:-?} opc-request-id=${req:-none}"
}

# Classifies a failed launch: capacity | transient | auth | fatal.
classify() {
  local out=$1 status code message
  status=$(field status "$out"); code=$(field code "$out"); message=$(field message "$out")
  if grep -qiE 'out of host capacity|OutOfCapacity|out of capacity' <<<"$out" || grep -q '"TERMINATED"' <<<"$out"; then
    echo capacity
  elif [[ $status == 429 || $code == TooManyRequests ]]; then
    echo transient
  elif [[ $status =~ ^5[0-9][0-9]$ ]]; then
    echo transient
  elif grep -qiE 'RequestException|timed out|timeout|connection (error|refused|reset|aborted)|ConnectionError|NewConnectionError|Max retries exceeded|RemoteDisconnected|Temporary failure in name resolution|Name or service not known|getaddrinfo|SSLError|EOF occurred' <<<"$out"; then
    echo transient
  elif [[ $status == 401 || $code == NotAuthenticated ]] || grep -qiE 'clock skew|date header|request (has )?expired|signature.*(expired|time)' <<<"$out"; then
    echo auth
  else
    echo fatal
  fi
}

public_ip() {
  oci compute instance list-vnics --instance-id "$1" --query 'data[0]."public-ip"' --raw-output 2>/dev/null
}

report() { # instance id, attempt count, result (launched|exists)
  output result "$3"
  if [[ $CI == true ]]; then
    # Never put the address in public logs; the local run saves it.
    log "instance is RUNNING ($3). Run scripts/oci-capacity-probe.sh locally to save its address."
    return
  fi
  local ip
  ip=$(public_ip "$1")
  echo "INSTANCE_ID=$1" >"$HOME/larper-oci-instance.env"
  echo "PUBLIC_IP=$ip" >>"$HOME/larper-oci-instance.env"
  log "instance $1 at $ip (saved to ~/larper-oci-instance.env); ssh -i ~/.ssh/larper_oci ubuntu@$ip"
  notify "Larper: Oracle A1 instance is up" "$OCPUS OCPU / $MEMORY_GB GB at $ip after $2 attempt(s). ssh -i ~/.ssh/larper_oci ubuntu@$ip"
}

# Two probes (laptop + GitHub Actions) can launch in the same minute. Keep the oldest
# instance and terminate the rest, so there is only ever one.
dedupe() {
  local ids keep
  ids=$(instances_in '["PROVISIONING","STARTING","RUNNING"]')
  keep=$(head -1 <<<"$ids")
  for id in $(tail -n +2 <<<"$ids"); do
    log "a second $NAME exists (another probe won the race); terminating $id, keeping $keep" >&2
    oci compute instance terminate --instance-id "$id" --preserve-boot-volume false --force >/dev/null 2>&1
  done
  echo "$keep"
}

command -v oci >/dev/null || die "oci CLI not found"
[[ -f "$OCI_CONFIG" ]] || die "no OCI config at $OCI_CONFIG"
TENANCY=$(awk -F' *= *' '/^\[DEFAULT\]/{d=1;next} /^\[/{d=0} d&&$1=="tenancy"{print $2}' "$OCI_CONFIG")
[[ -n "$TENANCY" ]] || die "no tenancy in $OCI_CONFIG [DEFAULT]"

if [[ -n "${SSH_PUB_FILE:-}" ]]; then
  [[ -s "$SSH_PUB_FILE" ]] || die "SSH_PUB_FILE $SSH_PUB_FILE is empty or missing"
  PUBKEY_FILE=$SSH_PUB_FILE
else
  if [[ ! -f "$SSH_KEY.pub" ]]; then
    mkdir -p "$(dirname "$SSH_KEY")" && chmod 700 "$(dirname "$SSH_KEY")"
    ssh-keygen -q -t ed25519 -N "" -C larper-oci -f "$SSH_KEY" || die "can't generate $SSH_KEY"
    log "generated SSH key $SSH_KEY"
  fi
  # The CLI is a Windows program under Git Bash: hand it a Windows path.
  PUBKEY_FILE=$(cygpath -w "$SSH_KEY.pub" 2>/dev/null || echo "$SSH_KEY.pub")
fi

existing=$(instances_in '["PROVISIONING","STARTING","RUNNING","STOPPING","STOPPED"]' | head -1)
if [[ -n "$existing" ]]; then
  report "$existing" 0 exists
  exit 0
fi

# Old probe network (private subnet, no gateway): delete it, it is never used again.
first_id() { "$@" --lifecycle-state AVAILABLE --query 'data[0].id' --raw-output 2>/dev/null | grep -o 'ocid1\.[^"]*'; }
OLD_VCN=$(first_id oci network vcn list --compartment-id "$TENANCY" --display-name "$OLD_NAME")
if [[ -n "$OLD_VCN" ]]; then
  for s in $(oci network subnet list --compartment-id "$TENANCY" --vcn-id "$OLD_VCN" \
               --query 'data[].id' --raw-output 2>/dev/null | grep -o 'ocid1\.subnet[^"]*'); do
    oci network subnet delete --subnet-id "$s" --force --wait-for-state TERMINATED >/dev/null 2>&1
  done
  oci network vcn delete --vcn-id "$OLD_VCN" --force --wait-for-state TERMINATED >/dev/null 2>&1 \
    && log "deleted old probe VCN $OLD_NAME" || log "couldn't delete old VCN $OLD_NAME (harmless; delete it in the console)"
fi

# Setup calls: same error handling as the launch, but no long retry loop.
# Not called inside $(...), so die and exit stop this shell, not a subshell.
try() { # description, command...: TRY_OUT = the output on success; die with the full error otherwise
  local what=$1 out kind n
  shift
  for n in $(seq 1 "$MAX_TRANSIENT"); do
    if out=$("$@" 2>&1); then TRY_OUT=$out; return 0; fi
    kind=$(classify "$out")
    [[ $kind == transient && $n -lt $MAX_TRANSIENT ]] || break
    log "$what: transient error ($n/$MAX_TRANSIENT), retrying in ${RETRY_DELAY}s: $(describe_error "$out")"
    sleep "$RETRY_DELAY"
  done
  if [[ $kind == transient && $ONCE == 1 ]]; then
    log "$what: $(describe_error "$out"); the next scheduled run retries"
    output result transient
    output summary "$what: $(describe_error "$out")"
    exit 0
  fi
  die "$what: $(describe_error "$out")"
}

try "list availability domains" oci iam availability-domain list --compartment-id "$TENANCY" \
  --query 'data[0].name' --raw-output
AD=$TRY_OUT
try "find the Ubuntu 24.04 aarch64 image" oci compute image list --compartment-id "$TENANCY" \
  --operating-system "Canonical Ubuntu" --operating-system-version "24.04" --shape VM.Standard.A1.Flex \
  --sort-by TIMECREATED --sort-order DESC --limit 1 --query 'data[0].id' --raw-output
IMAGE=$TRY_OUT
[[ $IMAGE == ocid1.* ]] || die "no Ubuntu 24.04 aarch64 image found"

# Public network: VCN -> internet gateway -> route table, SSH-only security list.
VCN=$(first_id oci network vcn list --compartment-id "$TENANCY" --display-name "$NAME")
if [[ -z "$VCN" ]]; then
  try "create VCN $NAME" oci network vcn create --compartment-id "$TENANCY" --display-name "$NAME" \
    --cidr-blocks '["10.99.0.0/16"]' --dns-label larper \
    --wait-for-state AVAILABLE --query 'data.id' --raw-output
  VCN=$TRY_OUT
  log "created VCN $VCN"
fi
IGW=$(first_id oci network internet-gateway list --compartment-id "$TENANCY" --vcn-id "$VCN" --display-name "$NAME")
if [[ -z "$IGW" ]]; then
  try "create the internet gateway" oci network internet-gateway create --compartment-id "$TENANCY" --vcn-id "$VCN" \
    --display-name "$NAME" --is-enabled true --wait-for-state AVAILABLE --query 'data.id' --raw-output
  IGW=$TRY_OUT
fi
RT=$(first_id oci network route-table list --compartment-id "$TENANCY" --vcn-id "$VCN" --display-name "$NAME")
if [[ -z "$RT" ]]; then
  try "create the route table" oci network route-table create --compartment-id "$TENANCY" --vcn-id "$VCN" --display-name "$NAME" \
    --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]" \
    --wait-for-state AVAILABLE --query 'data.id' --raw-output
  RT=$TRY_OUT
fi
SL=$(first_id oci network security-list list --compartment-id "$TENANCY" --vcn-id "$VCN" --display-name "$NAME")
if [[ -z "$SL" ]]; then
  try "create the security list" oci network security-list create --compartment-id "$TENANCY" --vcn-id "$VCN" --display-name "$NAME" \
    --ingress-security-rules '[
      {"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":22,"max":22}}},
      {"source":"0.0.0.0/0","protocol":"1","isStateless":false,"icmpOptions":{"type":3,"code":4}}]' \
    --egress-security-rules '[{"destination":"0.0.0.0/0","protocol":"all","isStateless":false}]' \
    --wait-for-state AVAILABLE --query 'data.id' --raw-output
  SL=$TRY_OUT
fi
SUBNET=$(first_id oci network subnet list --compartment-id "$TENANCY" --vcn-id "$VCN" --display-name "$NAME")
if [[ -z "$SUBNET" ]]; then
  try "create the public subnet" oci network subnet create --compartment-id "$TENANCY" --vcn-id "$VCN" --display-name "$NAME" \
    --cidr-block 10.99.1.0/24 --dns-label k3s --prohibit-public-ip-on-vnic false \
    --route-table-id "$RT" --security-list-ids "[\"$SL\"]" \
    --wait-for-state AVAILABLE --query 'data.id' --raw-output
  SUBNET=$TRY_OUT
  log "created public subnet $SUBNET"
fi

[[ $ONCE == 1 ]] && log "one attempt: $OCPUS OCPU / $MEMORY_GB GB in $AD" \
  || log "probing $OCPUS OCPU / $MEMORY_GB GB in $AD every ${INTERVAL}s (log: $LOG)"
attempt=0
transient=0     # transient errors in a row
woke=0          # 1 from a long gap until the next normal answer from OCI
planned=0       # seconds we meant to sleep before this attempt
slept_from=$SECONDS
while true; do
  attempt=$((attempt + 1))
  gap=$(( SECONDS - slept_from - planned ))
  if (( attempt > 1 && gap > LONG_GAP )); then
    woke=1
    log "attempt $attempt: $((gap / 60)) min later than planned (laptop asleep?); auth errors count as transient for now"
  fi

  # A fresh "already exists" check every attempt: the other probe may have won.
  existing=$(instances_in '["PROVISIONING","STARTING","RUNNING","STOPPING","STOPPED"]' | head -1)
  if [[ -n "$existing" ]]; then
    report "$existing" "$attempt" exists
    exit 0
  fi

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
    id=$(dedupe)
    report "$id" "$attempt" launched
    exit 0
  fi

  kind=$(classify "$out")
  [[ $kind == auth && $woke == 1 ]] && kind=transient
  case $kind in
    capacity)
      transient=0; woke=0
      [[ $ONCE == 1 ]] && log "attempt $attempt: out of capacity; the next scheduled run retries" \
        || log "attempt $attempt: out of capacity; next try in ${INTERVAL}s"
      output result no-capacity
      planned=$INTERVAL ;;
    transient)
      transient=$((transient + 1))
      log "attempt $attempt: transient error ($transient/$MAX_TRANSIENT in a row): $(describe_error "$out")"
      if [[ $ONCE == 1 ]]; then output result transient; output summary "$(describe_error "$out")"; exit 0; fi
      (( transient >= MAX_TRANSIENT )) && die "attempt $attempt: $MAX_TRANSIENT transient errors in a row; last: $(describe_error "$out")"
      planned=$RETRY_DELAY ;;
    *)
      die "attempt $attempt: $(describe_error "$out")" ;;
  esac
  [[ $ONCE == 1 ]] && exit 0
  slept_from=$SECONDS
  sleep "$planned"
done
