#!/usr/bin/env bash
# Tests for scripts/oci-capacity-probe.sh against a fake `oci` CLI (no Oracle account):
# the probe must never launch while larper-k3s exists, or when it can't tell.
#
#   scripts/test/oci-capacity-probe.test.sh     # CI runs it in the "helm" job
set -uo pipefail
cd "$(dirname "$0")/../.."
PROBE=$PWD/scripts/oci-capacity-probe.sh

fails=0
check() { # description, command...
  local what=$1; shift
  if "$@"; then echo "ok   $what"; else echo "FAIL $what"; fails=$((fails + 1)); fi
}

# A sandbox: fake HOME, OCI config, SSH key, and an `oci` on PATH that logs every call.
# FAKE_OCI=exists: one RUNNING larper-k3s. FAKE_OCI=broken: the instance lookup fails
# the way the CLI did before the --all fix (a usage error). Other calls get a stand-in id,
# and a launch succeeds: the tests look for whether one was attempted.
sandbox() {
  BOX=$(mktemp -d)
  mkdir -p "$BOX/bin" "$BOX/home/.oci"
  printf '[DEFAULT]\ntenancy=ocid1.tenancy.oc1..test\n' >"$BOX/home/.oci/config"
  echo "ssh-ed25519 AAAAtest larper-test" >"$BOX/key.pub"
  cat >"$BOX/bin/oci" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$FAKE_DIR/calls"
case "$*" in
  "compute instance list "*)
    if [[ $FAKE_OCI == broken ]]; then
      echo "UsageError: You must provide an --availability-domain when doing a --sort-by, unless you specify the --all parameter" >&2
      exit 2
    fi
    [[ "$*" == *--all* ]] || { echo "UsageError: --sort-by needs --all" >&2; exit 2; }
    [[ "$*" == *RUNNING* ]] && echo '["ocid1.instance.oc1.test.existing"]' || echo '[]' ;;
  "compute instance list-vnics "*) echo "203.0.113.7" ;;
  # A launch "succeeds", so a probe that gets this far is caught launching a second one.
  "compute instance launch "*) echo '{"id": "ocid1.instance.oc1.test.second", "state": "RUNNING"}' ;;
  # Setup lookups (availability domain, image, VCN, subnet, ...): any id will do.
  *) echo '"ocid1.thing.oc1.test.x"' ;;
esac
EOF
  chmod +x "$BOX/bin/oci"
}
run_probe() { # FAKE_OCI mode
  sandbox
  # No powershell.exe or ntfy: notify() only logs. PATH keeps the basics (bash, grep, sed).
  env -i PATH="$BOX/bin:/usr/bin:/bin" HOME="$BOX/home" FAKE_DIR="$BOX" FAKE_OCI="$1" \
    ONCE=1 SSH_PUB_FILE="$BOX/key.pub" LOG="$BOX/probe.log" \
    timeout 60 bash "$PROBE" >"$BOX/out" 2>&1 # a probe that goes on to retry setup would stall
  RC=$?
}
# Every CLI call other than the instance lookups (launch, network setup, deletes, ...).
others() { grep -v -e '^compute instance list ' -e '^compute instance list-vnics ' "$BOX/calls" 2>/dev/null; }

# 1. larper-k3s is RUNNING: report it, save its address, launch nothing.
run_probe exists
check "exists: exits 0" test "$RC" -eq 0
check "exists: never calls launch" bash -c "! grep -q 'instance launch' '$BOX/calls'"
check "exists: changes nothing (only the instance lookups)" test -z "$(others)"
check "exists: says so" grep -q 'instance ocid1.instance.oc1.test.existing at 203.0.113.7' "$BOX/probe.log"
check "exists: saves the id" grep -qx 'INSTANCE_ID=ocid1.instance.oc1.test.existing' "$BOX/home/larper-oci-instance.env"
check "exists: saves the address" grep -qx 'PUBLIC_IP=203.0.113.7' "$BOX/home/larper-oci-instance.env"
[[ $fails -gt 0 ]] && { cat "$BOX/out"; cat "$BOX/calls"; }

# 2. The lookup fails: stop, launch nothing ("couldn't look" is not "there is none").
run_probe broken
check "lookup fails: exits non-zero" test "$RC" -ne 0
check "lookup fails: never calls launch" bash -c "! grep -q 'instance launch' '$BOX/calls'"
check "lookup fails: changes nothing (only the instance lookups)" test -z "$(others)"
check "lookup fails: logs the CLI's error" grep -q 'instance lookup failed: UsageError' "$BOX/probe.log"
check "lookup fails: says it won't launch" grep -q "not launching" "$BOX/probe.log"

if ((fails)); then echo "$fails failed"; exit 1; fi
echo "all passed"
