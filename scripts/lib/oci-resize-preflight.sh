# shellcheck shell=bash
# The read-only half of resizing the Oracle VM, shared by scripts/oci-resize-check.sh
# and scripts/oci-up.sh --resize. It only reads (the instance, the tenancy's A1
# instances, quota, a capacity report) and prints what it found; it never changes
# anything, and it has no way to: no ssh, kubectl, helm or `oci ... update` here.
#
# Oracle's Always Free A1 allowance is 1,500 OCPU-hours and 9,000 GB-hours a month:
# 2 OCPU / 12 GB running all month (744 h: 1,488 and 8,928), for all A1 instances in
# the tenancy together. The quota policy larper-free-tier-caps holds the tenancy to it.
#
#   resize_preflight OCPUS MEMORY_GB   # needs INSTANCE_ID and OCI_CONFIG
#
# It runs in a subshell with set -euo pipefail, so anything that goes wrong inside (a
# failed CLI call, a bad value, a bash arithmetic error) ends it with a non-zero status,
# and every value is checked as well. Call it as a plain assignment, with set -e and
# inherit_errexit on in the caller:
#   out=$(resize_preflight 2 12)
# never `... || exit` or inside `if`: bash ignores set -e in anything on the left of ||
# or in an if condition, and a failed command inside would carry on.
# On success its stdout is lines of key=value: current_ocpus, current_memory_gb,
# availability_domain, capacity (AVAILABLE or Oracle's other status).

# The OCI CLI and Python print CRLF under Git Bash: strip it before anything compares.
preflight_nocr() { tr -d '\r'; }
preflight_int() { # what, value: a whole number, or the subshell ends
  [[ $2 =~ ^[0-9]+$ ]] || { echo "resize: $1 isn't a whole number: '$2'" >&2; exit 1; }
}
preflight_log() { echo "==> $*" >&2; }

resize_preflight() (
  set -euo pipefail
  o=$1 m=$2
  [[ -n ${INSTANCE_ID:-} ]] || { echo "resize: no INSTANCE_ID (it's for the Oracle VM)" >&2; exit 1; }
  [[ $o =~ ^[12]$ && $m =~ ^[0-9]+$ ]] && (( m >= 4 && m <= 12 )) \
    || { echo "resize: A1 sizes here are 1-2 OCPUs and 4-12 GB (Always Free: 2 OCPU / 12 GB in all)" >&2; exit 1; }
  tenancy=$(awk -F' *= *' '/^\[DEFAULT\]/{d=1;next} /^\[/{d=0} d&&$1=="tenancy"{print $2}' "$OCI_CONFIG" | preflight_nocr)
  [[ $tenancy == ocid1.tenancy.* ]] || { echo "resize: no tenancy in $OCI_CONFIG" >&2; exit 1; }

  inst=$(oci compute instance get --instance-id "$INSTANCE_ID" --query 'data' --output json)
  read -r cur_o cur_m ad < <(python -c 'import json,sys; d=json.load(sys.stdin); c=d["shape-config"]
print(int(c["ocpus"]), int(c["memory-in-gbs"]), d["availability-domain"])' <<<"$inst" | preflight_nocr)
  preflight_int "current OCPUs" "${cur_o:-}"
  preflight_int "current memory" "${cur_m:-}"
  [[ -n ${ad:-} ]] || { echo "resize: no availability domain for the instance" >&2; exit 1; }
  preflight_log "resize: $cur_o OCPU / $cur_m GB -> $o OCPU / $m GB ($ad)"

  # 1. $0: this VM plus every other A1 instance that isn't terminated (stopped ones
  #    hold no OCPU-hours, but would as soon as they start) within the allowance.
  read -r oo om < <(oci compute instance list --compartment-id "$tenancy" --all --output json \
    --query 'data[?shape==`VM.Standard.A1.Flex` && "lifecycle-state"!=`TERMINATED` && "lifecycle-state"!=`TERMINATING`]' \
    | python -c 'import json,sys; xs=[x for x in json.load(sys.stdin) if x["id"]!=sys.argv[1]]
print(sum(int(x["shape-config"]["ocpus"]) for x in xs), sum(int(x["shape-config"]["memory-in-gbs"]) for x in xs))' "$INSTANCE_ID" \
    | preflight_nocr)
  preflight_int "other A1 OCPUs" "${oo:-}"
  preflight_int "other A1 memory" "${om:-}"
  (( (o + oo) * 744 <= 1500 && (m + om) * 744 <= 9000 )) \
    || { echo "resize: over the Always Free allowance: $((o + oo)) OCPU / $((m + om)) GB across A1 instances" >&2; exit 1; }
  preflight_log "  \$0: $((o + oo)) OCPU x 744 h = $(((o + oo) * 744)) of 1,500 OCPU-h; $((m + om)) GB x 744 h = $(((m + om) * 744)) of 9,000 GB-h (other A1 instances: $oo / $om)"

  # 2. Quota: what's left for A1 in this AD, plus what this VM already holds.
  avail_o=$(oci limits resource-availability get --compartment-id "$tenancy" --service-name compute \
    --limit-name standard-a1-core-count --availability-domain "$ad" --query 'data.available' --raw-output | preflight_nocr)
  avail_m=$(oci limits resource-availability get --compartment-id "$tenancy" --service-name compute \
    --limit-name standard-a1-memory-count --availability-domain "$ad" --query 'data.available' --raw-output | preflight_nocr)
  avail_o=${avail_o%.0} avail_m=${avail_m%.0}
  preflight_int "A1 OCPU quota left" "$avail_o"
  preflight_int "A1 memory quota left" "$avail_m"
  (( avail_o + cur_o >= o && avail_m + cur_m >= m )) \
    || { echo "resize: quota allows only $((avail_o + cur_o)) OCPU / $((avail_m + cur_m)) GB for this VM" >&2; exit 1; }
  preflight_log "  quota: up to $((avail_o + cur_o)) OCPU / $((avail_m + cur_m)) GB for this VM"

  # 3. Capacity in its AD right now (a report: it reserves nothing).
  cap=$(oci compute compute-capacity-report create --compartment-id "$tenancy" --availability-domain "$ad" \
    --shape-availabilities "[{\"instanceShape\":\"VM.Standard.A1.Flex\",\"instanceShapeConfig\":{\"ocpus\":$o,\"memoryInGBs\":$m}}]" \
    --query 'data."shape-availabilities"[0]."availability-status"' --raw-output | preflight_nocr)
  [[ $cap =~ ^[A-Z_]+$ ]] || { echo "resize: unexpected capacity status '$cap'" >&2; exit 1; }
  preflight_log "  capacity for $o OCPU / $m GB in $ad: $cap"

  printf 'current_ocpus=%s\ncurrent_memory_gb=%s\navailability_domain=%s\ncapacity=%s\n' "$cur_o" "$cur_m" "$ad" "$cap"
)
