#!/usr/bin/env bash
# The public demo's shared account: one Clerk user that every visitor signs in as,
# with "Try the demo" (a one-time sign-in token from the API's POST /demo/sign-in). It
# has no password anyone knows: visitors never type one, and the reset sets a new
# random one each time.
#
#   scripts/demo-account.sh create          # once: the Clerk user, locked down; saves its id
#   scripts/demo-account.sh reset           # now, what the nightly demo-reset CronJob does
#   scripts/demo-account.sh reset --taste   # ...and its taste profile too (onboarding again)
#   scripts/demo-account.sh check           # sign-up mode, and the account's settings
#
# Reads CLERK_SECRET_KEY from apps/web/.env.local and keeps the account in DEMO_ENV
# (default ~/.oci/larper-demo.env, mode 600):
#   DEMO_EMAIL=demo@playlarper.com
#   DEMO_USER_ID=user_...    # `create` writes it; oci-up.sh puts it in the clerk-demo Secret
# `reset` runs on the cluster of the current kubectl context (KUBECONFIG; for the Oracle
# VM, the SSH tunnel oci-up.sh prints): a Job from the demo-reset CronJob
# (apps/api/src/ops/demo-reset.ts), then with --taste psql in the Postgres pod.
# Secrets are passed to curl in headers and request bodies on stdin, never printed.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1 # Git Bash: leave /v1/... paths alone

ENV_FILE=apps/web/.env.local
DEMO_ENV=${DEMO_ENV:-$HOME/.oci/larper-demo.env}
API=https://api.clerk.com/v1
NS=${NAMESPACE:-larper}

cmd=${1:-}
taste=0
[[ ${2:-} == --taste ]] && taste=1
case $cmd in create | reset | check) ;; *) echo "usage: $0 create | reset [--taste] | check" >&2; exit 2 ;; esac

[[ -f $ENV_FILE ]] || { echo "no $ENV_FILE: run this from the repo folder" >&2; exit 1; }
KEY=$(grep -E '^CLERK_SECRET_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'\r ')
[[ $KEY == sk_test_* ]] || { echo "CLERK_SECRET_KEY in $ENV_FILE is not a development key (sk_test_...); refusing" >&2; exit 1; }
PK=$(grep -E '^NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'\r ')

if [[ ! -s $DEMO_ENV && $cmd == create ]]; then
  umask 077
  mkdir -p "$(dirname "$DEMO_ENV")"
  printf 'DEMO_EMAIL=%s\n' "${DEMO_EMAIL:-demo@playlarper.com}" >"$DEMO_ENV"
  chmod 600 "$DEMO_ENV"
fi
[[ -s $DEMO_ENV ]] || { echo "no $DEMO_ENV: run '$0 create' first" >&2; exit 1; }
DEMO_EMAIL=$(grep -E '^DEMO_EMAIL=' "$DEMO_ENV" | cut -d= -f2- | tr -d '\r')
[[ -n $DEMO_EMAIL ]] || { echo "$DEMO_ENV needs DEMO_EMAIL" >&2; exit 1; }
export DEMO_EMAIL # read by node from the environment, never from argv

# clerk METHOD PATH [--json, body on stdin] -> $BODY, $STATUS. Call it directly, never in $(...)
# or as part of a pipe (a subshell: $BODY and $STATUS wouldn't come back); feed a body
# with <<<"$(body ...)".
STATUS=000 BODY=
clerk() {
  local out data=()
  [[ $# -ge 3 && $3 == --json ]] && data=(-H 'Content-Type: application/json' --data-binary @-)
  out=$(curl -sS -X "$1" "$API$2" -H "Authorization: Bearer $KEY" "${data[@]}" -w $'\n%{http_code}') || { STATUS=000; BODY=; return 1; }
  STATUS=${out##*$'\n'}
  BODY=${out%$'\n'*}
}
json() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log($1)})" <<<"$BODY"; }
# A JSON body built in node from environment variables, so no secret is on a command line.
body() { node -e "console.log(JSON.stringify($1))"; }

find_user() { # -> $USER_ID ("" if none)
  clerk GET "/users?email_address=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$DEMO_EMAIL")"
  [[ $STATUS == 200 ]] || { echo "looking up $DEMO_EMAIL failed: HTTP $STATUS" >&2; exit 1; }
  USER_ID=$(json 'j.length ? j[0].id : ""')
}

lock_down() { # the account can't delete itself or make organizations
  clerk PATCH "/users/$USER_ID" --json <<<"$(body '{delete_self_enabled: false, create_organization_enabled: false}')"
  [[ $STATUS == 200 ]] || { echo "locking down the account failed: HTTP $STATUS: $BODY" >&2; exit 1; }
}

save_user_id() { # DEMO_ENV keeps the email and the id, and no password
  local tmp
  tmp=$(mktemp) && printf 'DEMO_EMAIL=%s\nDEMO_USER_ID=%s\n' "$DEMO_EMAIL" "$USER_ID" >"$tmp" \
    && chmod 600 "$tmp" && mv "$tmp" "$DEMO_ENV"
}

sign_up_mode() { # Clerk's public environment (what every browser loads): no secret needed
  local fapi
  fapi=$(node -e 's=process.argv[1].split("_").slice(2).join("_");console.log(Buffer.from(s,"base64").toString().replace(/\$$/,""))' "$PK")
  curl -sS "https://$fapi/v1/environment" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).user_settings.sign_up.mode))"
}

case $cmd in
  create)
    find_user
    if [[ -n $USER_ID ]]; then
      echo "$DEMO_EMAIL already exists ($USER_ID); locking it down"
    else
      # A random password nobody keeps: visitors sign in with tokens, and the reset
      # replaces it anyway.
      clerk POST /users --json <<<"$(body '{email_address: [process.env.DEMO_EMAIL], password: require("crypto").randomBytes(24).toString("base64url")}')"
      [[ $STATUS == 200 ]] || { echo "creating $DEMO_EMAIL failed: HTTP $STATUS: $BODY" >&2; exit 1; }
      USER_ID=$(json 'j.id')
      echo "created $DEMO_EMAIL ($USER_ID)"
    fi
    lock_down
    save_user_id
    echo "saved its id to $DEMO_ENV (oci-up.sh puts it in the clerk-demo Secret)."
    echo "done. It signs up nobody else: set Clerk's sign-up mode to Restricted (now: $(sign_up_mode))."
    ;;

  reset)
    # What the nightly CronJob does, now: a Job from it, so there's one implementation.
    ctx=$(kubectl config current-context 2>/dev/null || echo '?')
    kubectl -n "$NS" get cronjob demo-reset >/dev/null 2>&1 \
      || { echo "no CronJob demo-reset in $NS (context $ctx): is the chart deployed with demo.enabled?" >&2; exit 1; }
    job=demo-reset-manual-$(date +%s)
    echo "cluster: context $ctx, namespace $NS: job $job"
    kubectl -n "$NS" create job "$job" --from=cronjob/demo-reset >/dev/null || exit 1
    if ! kubectl -n "$NS" wait "job/$job" --for=condition=Complete --timeout=180s >/dev/null; then
      kubectl -n "$NS" logs "job/$job" --tail=20 >&2
      echo "the reset failed" >&2
      exit 1
    fi
    kubectl -n "$NS" logs "job/$job" --tail=5
    kubectl -n "$NS" delete job "$job" --wait=false >/dev/null

    # With --taste, its taste profile too (onboarding again), as the database owner.
    if [[ $taste == 1 ]]; then
      find_user
      [[ $USER_ID =~ ^user_[A-Za-z0-9]+$ ]] || { echo "no Clerk user $DEMO_EMAIL" >&2; exit 1; }
      kubectl -n "$NS" exec -i pg-1 -c postgres -- psql -U postgres -d larper -X -q -v ON_ERROR_STOP=1 \
        -v cid="$USER_ID" -f - <<'SQL'
\set QUIET on
WITH t AS (DELETE FROM taste_profiles WHERE user_id = (SELECT id FROM users WHERE clerk_id = :'cid') RETURNING 1)
SELECT 'taste profile deleted: ' || count(*) FROM t \g (tuples_only=on)
SQL
    fi
    ;;

  check)
    echo "Clerk sign-up mode: $(sign_up_mode)   (want: restricted)"
    find_user
    if [[ -z $USER_ID ]]; then echo "no Clerk user $DEMO_EMAIL"; exit 1; fi
    saved=$(grep -E '^DEMO_USER_ID=' "$DEMO_ENV" | cut -d= -f2- | tr -d '\r')
    [[ $saved == "$USER_ID" ]] || echo "WARNING: $DEMO_ENV has DEMO_USER_ID=${saved:-none}; run '$0 create' to save $USER_ID"
    clerk GET "/users/$USER_ID"
    json '`account ${j.id}: delete_self_enabled=${j.delete_self_enabled} create_organization_enabled=${j.create_organization_enabled} two_factor=${j.two_factor_enabled} emails=${j.email_addresses.length} last_sign_in=${j.last_sign_in_at ? new Date(j.last_sign_in_at).toISOString() : "never"}`'
    ;;
esac
