#!/usr/bin/env bash
# Tests that scripts/oci-up.sh fails closed, against fake CLIs (no Oracle account, no VM):
# - a check mode (--resize-check) never reaches a deploy step, whatever the OCI CLI
#   answers: bad values, Windows CRLF, failures;
# - --resize refuses before rebooting anything when a check fails;
# - a dirty working tree is refused unless --allow-dirty is given.
# "A deploy step" is any call to ssh, scp, kubectl, helm, docker or terraform (faked here
# to record the call and fail), or an OCI call that changes something.
#
#   scripts/test/oci-up-guards.test.sh     # CI runs it in the "helm" job
set -uo pipefail
cd "$(dirname "$0")/../.."
UP=scripts/oci-up.sh # relative: the tests run from the repo root (Git Bash under env -i mangles absolute paths)
# The interpreters by absolute path, never by a PATH search: on Windows the Python
# install's neighbour WindowsApps holds bash.exe (WSL's), which would run the script in
# another system with none of this environment. Python is reached through a wrapper.
BASH_BIN=$BASH
PY_BIN=$(command -v python 2>/dev/null || command -v python3)
[[ $PY_BIN != */WindowsApps/* ]] || PY_BIN=$(command -v python3)

fails=0
check() { # description, command...
  local what=$1; shift
  if "$@"; then echo "ok   $what"; else echo "FAIL $what"; fails=$((fails + 1)); fi
}

# A sandbox: fake HOME, OCI config, instance env, and fake CLIs on PATH.
# FAKE_OCI: good | crlf (good values, Windows line endings) | bad-quota (a value that
# isn't a number) | bad-instance (the instance lookup fails) | no-capacity |
# regional-zero (per-AD quota allows 2/12, the regional quota is zeroed and already
# overrun by the 1/6 VM, as on 2026-10-24).
# FAKE_GIT_STATUS: what `git status --porcelain` prints (empty: a clean tree).
sandbox() {
  BOX=$(mktemp -d)
  mkdir -p "$BOX/bin" "$BOX/home/.oci"
  printf '[DEFAULT]\ntenancy=ocid1.tenancy.oc1..test\n' >"$BOX/home/.oci/config"
  printf 'INSTANCE_ID=ocid1.instance.oc1.test.vm\nPUBLIC_IP=203.0.113.7\n' >"$BOX/instance.env"
  : >"$BOX/deploy-calls" && : >"$BOX/oci-calls"
  cat >"$BOX/bin/oci" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$FAKE_DIR/oci-calls"
eol=$'\n'; [[ $FAKE_OCI == crlf ]] && eol=$'\r\n'
out() { printf '%s%s' "$1" "$eol"; }
case "$*" in
  "compute instance get "*)
    [[ $FAKE_OCI == bad-instance ]] && { echo "ServiceError: NotAuthorizedOrNotFound" >&2; exit 1; }
    out '{"shape-config": {"ocpus": 1.0, "memory-in-gbs": 6.0}, "availability-domain": "TEST:AD-1"}' ;;
  "compute instance list "*) out '[]' ;;
  "limits resource-availability get "*)
    [[ $FAKE_OCI == bad-quota ]] && { out 'None oops'; exit 0; }
    case "$*" in
      *core-regional-count*) [[ $FAKE_OCI == regional-zero ]] && out '-1.0' || out '1.0' ;;
      *memory-regional-count*) [[ $FAKE_OCI == regional-zero ]] && out '-6.0' || out '6.0' ;;
      *core-count*) out '1.0' ;;
      *) out '6.0' ;;
    esac ;;
  "compute compute-capacity-report create "*)
    [[ $FAKE_OCI == no-capacity ]] && out 'OUT_OF_HOST_CAPACITY' || out 'AVAILABLE' ;;
  *) echo "MUTATE oci $*" >>"$FAKE_DIR/deploy-calls"; out '{}' ;;
esac
EOF
  for tool in ssh scp kubectl helm docker terraform; do
    printf '#!/usr/bin/env bash\necho "%s $*" >>"$FAKE_DIR/deploy-calls"\nexit 1\n' "$tool" >"$BOX/bin/$tool"
  done
  cat >"$BOX/bin/git" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  status) printf '%s' "${FAKE_GIT_STATUS:-}" ;;
  rev-parse) echo abc1234 ;;
  *) exit 0 ;;
esac
EOF
  printf '#!%s
exec "%s" "$@"
' "$BASH_BIN" "$PY_BIN" >"$BOX/bin/python"
  chmod +x "$BOX"/bin/*
}
run_up() { # FAKE_OCI mode, FAKE_GIT_STATUS, oci-up.sh arguments...
  local mode=$1 status=$2; shift 2
  sandbox
  env -i PATH="$BOX/bin:/usr/bin:/bin" HOME="$BOX/home" FAKE_DIR="$BOX" FAKE_OCI="$mode" \
    FAKE_GIT_STATUS="$status" OCI_ENV_FILE="$BOX/instance.env" OCI_CLI_CONFIG_FILE="$BOX/home/.oci/config" \
    PUBLIC_ENV=/nonexistent SSH_KEY="$BOX/no-key" \
    timeout 60 "$BASH_BIN" "$UP" "$@" >"$BOX/out" 2>&1
  RC=$?; [[ -n ${DEBUG:-} ]] && { echo "--- rc=$RC"; cat "$BOX/out"; }
}
no_deploy() { [[ ! -s $BOX/deploy-calls ]]; }
said() { grep -q -- "$1" "$BOX/out"; }

# 1. A check with good values (and CRLF, as the OCI CLI prints under Git Bash): passes,
#    changes nothing.
run_up crlf "" --resize-check 2 12
check "check, CRLF values: exits 0" test "$RC" -eq 0
check "check, CRLF values: says nothing changed" said "nothing changed"
check "check, CRLF values: no deploy step" no_deploy

# 2. A check with a value that isn't a number: refuses, and never deploys.
run_up bad-quota "" --resize-check 2 12
check "check, bad CLI value: exits non-zero" test "$RC" -ne 0
check "check, bad CLI value: names the bad value" said "isn't a whole number"
check "check, bad CLI value: no deploy step" no_deploy

# 3. A check whose instance lookup fails: refuses, never deploys.
run_up bad-instance "" --resize-check 2 12
check "check, failed lookup: exits non-zero" test "$RC" -ne 0
check "check, failed lookup: stops at the CLI's error" said "NotAuthorizedOrNotFound"
check "check, failed lookup: no deploy step" no_deploy

# 4. A check over the allowance, and one without capacity: no deploy either way.
run_up good "" --resize-check 2 16
check "check, over the allowance: exits non-zero" test "$RC" -ne 0
check "check, over the allowance: says why" said "A1 sizes here"
check "check, over the allowance: no deploy step" no_deploy
run_up no-capacity "" --resize-check 2 12
check "check, no capacity: exits 3" test "$RC" -eq 3
check "check, no capacity: says try later" said "try later"
check "check, no capacity: no deploy step" no_deploy

# 4b. Per-AD quota allows it but the regional quota doesn't: refuses (Oracle checks
#     a resize against the regional one), with the negative availability parsed.
run_up regional-zero "" --resize-check 2 12
check "check, regional quota zeroed: exits non-zero" test "$RC" -ne 0
check "check, regional quota zeroed: says the quota allows less" said "quota allows only 0 OCPU / 0 GB"
check "check, regional quota zeroed: shows both limits" said "in the region"
check "check, regional quota zeroed: no deploy step" no_deploy
check "check, regional quota zeroed: asked for the regional limits" grep -q 'core-regional-count' "$BOX/oci-calls"
run_up regional-zero "" --resize 2 12
check "resize, regional quota zeroed: exits non-zero" test "$RC" -ne 0
check "resize, regional quota zeroed: no deploy step and no instance update" no_deploy

# 5. A check from a dirty tree is still only a check (it's read-only).
run_up good " M scripts/oci-up.sh" --resize-check 2 12
check "check, dirty tree: exits 0" test "$RC" -eq 0
check "check, dirty tree: no deploy step" no_deploy

# 6. An unknown check mode is refused before anything.
run_up good "" --cost-check
check "unknown check: exits 2" test "$RC" -eq 2
check "unknown check: says so" said "unknown check --cost-check"
check "unknown check: no deploy step" no_deploy

# 7. --resize with a bad CLI value: refuses before the backup, the reboot or the deploy.
run_up bad-quota "" --resize 2 12
check "resize, bad CLI value: exits non-zero" test "$RC" -ne 0
check "resize, bad CLI value: names the bad value" said "isn't a whole number"
check "resize, bad CLI value: no deploy step and no instance update" no_deploy

# 8. A dirty tree is refused before anything remote; --allow-dirty gets past the guard
#    (the first remote step, the security list lookup, is then reached and fails).
run_up good " M infra/helm/larper/values.yaml
?? infra/helm/larper/new.yaml"
check "dirty tree: exits non-zero" test "$RC" -ne 0
check "dirty tree: says why, and lists the files" bash -c "grep -q 'dirty working tree' '$BOX/out' && grep -q 'new.yaml' '$BOX/out'"
check "dirty tree: no deploy step" no_deploy
run_up good " M infra/helm/larper/values.yaml" --allow-dirty
check "dirty tree + --allow-dirty: gets past the guard to the first remote step" grep -q 'network vcn list' "$BOX/oci-calls"
run_up good ""
check "clean tree: gets past the guard to the first remote step" grep -q 'network vcn list' "$BOX/oci-calls"

echo
if ((fails)); then echo "$fails failed"; exit 1; fi
echo "all passed"
