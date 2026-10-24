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
# Fake, well-shaped secret values, assembled here (see the sandbox's note).
FAKE_SQS_SECRET=$(printf 'abcdefghij%.0s' 1 2 3 4) # 40 characters
FAKE_S3_SECRET=$(printf 'Zyxwvutsrq%.0s' 1 2 3 4)
FAKE_S3_ID=$(printf '0123456789%.0s' 1 2 3 4)
FAKE_CLERK_KEY=$(printf 'sk_%s_%s' test FakeFakeFake123)
FAKE_TF=good FAKE_S3=none FAKE_CHECK=none FAKE_DEMO=none
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
# The Secrets' sources (scripts/lib/oci-secrets.sh), set by a test before run_up and
# all well-formed by default:
#   FAKE_TF: good | fail (terraform output exits 1) | empty (exits 0, prints nothing) |
#     bad (prints something that isn't a key)
#   FAKE_S3, FAKE_CHECK, FAKE_DEMO: none (no file) | good | a broken variant below
# The fake key values are built at run time, so no key-shaped literal sits in this file
# for the secret scan to flag.
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
  cat >"$BOX/bin/terraform" <<'EOF'
#!/usr/bin/env bash
case $FAKE_TF in
  fail) echo "Error: Required plugins are not installed" >&2; exit 1 ;;
  empty) exit 0 ;;
  bad) printf 'not-a-key' ;;
  *) [[ "$*" == *access_key_id* ]] && printf '%s%s' AKIA TESTTESTTEST1234 || printf '%s' "$FAKE_SQS_SECRET" ;;
esac
EOF
  local s3="ACCESS_KEY_ID=$FAKE_S3_ID
ACCESS_SECRET_KEY=$FAKE_S3_SECRET
REGION=us-sanjose-1"
  case $FAKE_S3 in
    good) printf '%s\n' "$s3" >"$BOX/s3.env" ;;
    no-secret) grep -v '^ACCESS_SECRET_KEY=' <<<"$s3" >"$BOX/s3.env" ;;
    bad-region) sed 's/^REGION=.*/REGION=San Jose/' <<<"$s3" >"$BOX/s3.env" ;;
  esac
  case $FAKE_CHECK in
    good) echo 'pingURL=https://hc-ping.com/00000000-0000-0000-0000-000000000000' >"$BOX/check.env" ;;
    http) echo 'pingURL=http://hc-ping.com/00000000' >"$BOX/check.env" ;;
    empty) : >"$BOX/check.env" ;;
  esac
  case $FAKE_DEMO in
    good | no-key | bad-key) echo 'DEMO_USER_ID=user_3KZtest' >"$BOX/demo.env" ;;
    bad-user) echo 'DEMO_USER_ID=3KZtest' >"$BOX/demo.env" ;;
  esac
  case $FAKE_DEMO in
    good | bad-user) printf 'CLERK_SECRET_KEY="%s"\n' "$FAKE_CLERK_KEY" >"$BOX/web.env" ;;
    no-key) echo 'NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in' >"$BOX/web.env" ;;
    bad-key) echo 'CLERK_SECRET_KEY=pk_test_wrongkind' >"$BOX/web.env" ;;
  esac
  for tool in ssh scp kubectl helm docker; do
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
    PUBLIC_ENV=/nonexistent SSH_KEY="$BOX/no-key" FAKE_TF="$FAKE_TF" FAKE_SQS_SECRET="$FAKE_SQS_SECRET" \
    S3_ENV="$BOX/s3.env" CHECK_ENV="$BOX/check.env" DEMO_ENV="$BOX/demo.env" WEB_ENV="$BOX/web.env" \
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

# 9. Each Secret's source broken in turn: the deploy stops before anything remote (no
#    OCI call at all: no security list, bootstrap, backup or reboot), names the value
#    and where it comes from, and prints no secret.
no_remote() { [[ ! -s $BOX/oci-calls ]] && no_deploy; }
reached_remote() { grep -q 'network vcn list' "$BOX/oci-calls"; }
prints_no_secret() { ! grep -qE "TESTTESTTEST1234|$FAKE_SQS_SECRET|$FAKE_S3_SECRET|FakeFakeFake123" "$BOX/out"; }
broken() { # description, expected message, FAKE_*=value..., -- oci-up.sh arguments...
  local what=$1 msg=$2 kv; shift 2
  while [[ $# -gt 0 && $1 != -- ]]; do printf -v "${1%%=*}" '%s' "${1#*=}"; shift; done
  [[ ${1:-} == -- ]] && shift
  run_up good "" "$@"
  FAKE_TF=good FAKE_S3=none FAKE_CHECK=none FAKE_DEMO=none
  check "$what: exits non-zero" test "$RC" -ne 0
  check "$what: says which value, from where" said "$msg"
  check "$what: nothing remote, no deploy step" no_remote
  check "$what: prints no secret" prints_no_secret
}
broken "aws-sqs, terraform output fails" "Required plugins are not installed" FAKE_TF=fail
broken "aws-sqs, terraform output empty" "aws-sqs access_key_id (terraform output, infra/terraform/aws) is empty" FAKE_TF=empty
broken "aws-sqs, terraform output not a key" "aws-sqs access_key_id (terraform output, infra/terraform/aws) isn't in the expected shape" FAKE_TF=bad
broken "aws-sqs failing before a resize" "Required plugins are not installed" FAKE_TF=fail -- --resize 2 12
broken "pg-backup-s3, no secret key in the file" "pg-backup-s3 ACCESS_SECRET_KEY (.*s3.env) is empty" FAKE_S3=no-secret
broken "pg-backup-s3, region malformed" "pg-backup-s3 REGION (.*s3.env) isn't in the expected shape" FAKE_S3=bad-region
broken "backup-check, not an https URL" "backup-check pingURL (.*check.env) isn't in the expected shape" FAKE_CHECK=http
broken "backup-check, empty file" "backup-check pingURL (.*check.env) is empty" FAKE_CHECK=empty
broken "clerk-demo, key missing (no longer turns the demo off quietly)" "clerk-demo secretKey (CLERK_SECRET_KEY in .*web.env) is empty" FAKE_DEMO=no-key
broken "clerk-demo, not a secret key" "clerk-demo secretKey (CLERK_SECRET_KEY in .*web.env) isn't in the expected shape" FAKE_DEMO=bad-key
broken "clerk-demo, user id malformed" "clerk-demo userId (DEMO_USER_ID in .*demo.env) isn't in the expected shape" FAKE_DEMO=bad-user

# 10. All of them present and well-formed (a quoted Clerk key too): past the checks to
#     the first remote step, with nothing printed.
FAKE_S3=good FAKE_CHECK=good FAKE_DEMO=good
run_up good ""
FAKE_TF=good FAKE_S3=none FAKE_CHECK=none FAKE_DEMO=none
check "all Secrets well-formed: gets past the checks to the first remote step" reached_remote
check "all Secrets well-formed: prints no secret" prints_no_secret

# 11. --close writes no Secret, so a broken source doesn't stop it.
FAKE_TF=fail
run_up good "" --close
FAKE_TF=good
check "--close with terraform failing: still gets to the security list" reached_remote

echo
if ((fails)); then echo "$fails failed"; exit 1; fi
echo "all passed"
