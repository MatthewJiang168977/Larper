#!/usr/bin/env bash
# Can the Oracle VM become OCPUS / MEMORY_GB at $0, now? Read-only: the Always Free
# math, the A1 quota left and a capacity report (scripts/lib/oci-resize-preflight.sh).
# It has no deploy code at all; scripts/oci-up.sh --resize-check runs this and nothing
# else, and scripts/oci-up.sh --resize does the change.
#
#   scripts/oci-resize-check.sh 2 12    # exit 0: allowed and capacity AVAILABLE
#                                       # exit 1: refused, or a value it couldn't read
#                                       # exit 3: allowed, but no capacity right now
set -euo pipefail
# Errors inside $(...) count too: the preflight below runs in one.
shopt -s inherit_errexit
cd "$(dirname "$0")/.."
[[ $# -eq 2 ]] || { echo "usage: $0 OCPUS MEMORY_GB   (e.g. 2 12, or 1 6 to go back)" >&2; exit 2; }

ENV_FILE=${OCI_ENV_FILE:-$HOME/larper-oci-instance.env}
OCI_CONFIG=${OCI_CLI_CONFIG_FILE:-$HOME/.oci/config}
[[ -f $ENV_FILE ]] || { echo "no $ENV_FILE: run scripts/oci-capacity-probe.sh (it saves the VM's id)" >&2; exit 1; }
INSTANCE_ID=$(grep -E '^INSTANCE_ID=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r"'"'")
export INSTANCE_ID OCI_CONFIG
# shellcheck source=lib/oci-resize-preflight.sh
source scripts/lib/oci-resize-preflight.sh

# A plain assignment, never `|| ...` or `if`: bash ignores set -e inside anything on
# the left of || (that is how a failed lookup once fell through), so here a failure
# anywhere in the preflight ends this script.
out=$(resize_preflight "$1" "$2")
capacity=$(sed -n 's/^capacity=//p' <<<"$out")
if [[ $capacity == AVAILABLE ]]; then
  echo "==> check only: nothing changed. Allowed, and Oracle has capacity now."
else
  echo "==> check only: nothing changed. Allowed, but capacity is $capacity: try later."
  exit 3
fi
