#!/usr/bin/env bash
# The public demo's shared account: one Clerk user that anyone may sign in as
# (the web app shows its email and password on the sign-in page).
#
#   scripts/demo-account.sh create          # once: the Clerk user, locked down
#   scripts/demo-account.sh reset           # sign everyone out, restore the password, clear its quests
#   scripts/demo-account.sh reset --taste   # ...and its taste profile too (onboarding again)
#   scripts/demo-account.sh check           # sign-up mode, and the account's settings
#
# Reads CLERK_SECRET_KEY from apps/web/.env.local and the account from DEMO_ENV
# (default ~/.oci/larper-demo.env, mode 600):
#   DEMO_EMAIL=demo@playlarper.com
#   DEMO_PASSWORD=...        # 15+ characters (the instance's minimum); `create` makes one if missing
# The database part runs psql in the Postgres pod of the current kubectl context
# (KUBECONFIG; for the Oracle VM, the SSH tunnel oci-up.sh prints).
#
# A shared password is known to everyone who uses it, so anyone signed in could change
# it or add an email. `reset` puts the password back and revokes every session; the
# account can't delete itself or create organizations (set by `create`, kept by `reset`).
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
  pw=$(node -e 'console.log(require("crypto").randomBytes(18).toString("base64url"))')
  printf 'DEMO_EMAIL=%s\nDEMO_PASSWORD=%s\n' "${DEMO_EMAIL:-demo@playlarper.com}" "$pw" >"$DEMO_ENV"
  chmod 600 "$DEMO_ENV"
  echo "wrote $DEMO_ENV (a new password; put the same values in Vercel's NEXT_PUBLIC_DEMO_*)"
fi
[[ -s $DEMO_ENV ]] || { echo "no $DEMO_ENV: run '$0 create' first" >&2; exit 1; }
DEMO_EMAIL=$(grep -E '^DEMO_EMAIL=' "$DEMO_ENV" | cut -d= -f2- | tr -d '\r')
DEMO_PASSWORD=$(grep -E '^DEMO_PASSWORD=' "$DEMO_ENV" | cut -d= -f2- | tr -d '\r')
[[ -n $DEMO_EMAIL && ${#DEMO_PASSWORD} -ge 15 ]] || { echo "$DEMO_ENV needs DEMO_EMAIL and a DEMO_PASSWORD of 15+ characters" >&2; exit 1; }
export DEMO_EMAIL DEMO_PASSWORD # read by node from the environment, never from argv

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
      clerk POST /users --json <<<"$(body '{email_address: [process.env.DEMO_EMAIL], password: process.env.DEMO_PASSWORD}')"
      [[ $STATUS == 200 ]] || { echo "creating $DEMO_EMAIL failed: HTTP $STATUS: $BODY" >&2; exit 1; }
      USER_ID=$(json 'j.id')
      echo "created $DEMO_EMAIL ($USER_ID)"
    fi
    lock_down
    echo "done. It signs up nobody else: set Clerk's sign-up mode to Restricted (now: $(sign_up_mode))."
    ;;

  reset)
    find_user
    [[ -n $USER_ID ]] || { echo "no Clerk user $DEMO_EMAIL: run '$0 create'" >&2; exit 1; }
    # 1. Everyone out, then the password back (sessions first, so a visitor's open tab
    #    can't change it again in between).
    clerk GET "/sessions?user_id=$USER_ID&status=active&limit=500"
    [[ $STATUS == 200 ]] || { echo "listing sessions failed: HTTP $STATUS" >&2; exit 1; }
    revoked=0
    for sid in $(json 'j.map(s=>s.id).join(" ")'); do
      clerk POST "/sessions/$sid/revoke" && [[ $STATUS == 200 ]] && revoked=$((revoked + 1))
    done
    clerk PATCH "/users/$USER_ID" --json <<<"$(body '{password: process.env.DEMO_PASSWORD}')"
    [[ $STATUS == 200 ]] || { echo "restoring the password failed: HTTP $STATUS" >&2; exit 1; }
    lock_down
    echo "Clerk: revoked $revoked session(s), password restored, still can't delete itself"

    # 2. Its quests (journal and today's quest), and with --taste its taste profile.
    [[ $USER_ID =~ ^user_[A-Za-z0-9]+$ ]] || { echo "unexpected Clerk user id" >&2; exit 1; }
    echo "database: context $(kubectl config current-context 2>/dev/null || echo '?'), namespace $NS"
    kubectl -n "$NS" exec -i pg-1 -c postgres -- psql -U postgres -d larper -X -q -v ON_ERROR_STOP=1 \
      -v cid="$USER_ID" -v taste="$taste" -f - <<'SQL'
\set QUIET on
SELECT (SELECT id FROM users WHERE clerk_id = :'cid') AS uid,
       EXISTS (SELECT FROM users WHERE clerk_id = :'cid') AS found \gset
\if :found
  WITH q AS (DELETE FROM quests WHERE user_id = :uid RETURNING 1)
  SELECT 'quests deleted: ' || count(*) FROM q \g (tuples_only=on)
  \if :taste
    WITH t AS (DELETE FROM taste_profiles WHERE user_id = :uid RETURNING 1)
    SELECT 'taste profile deleted: ' || count(*) FROM t \g (tuples_only=on)
  \endif
\else
  \echo 'no app user yet (the account has never used the API): nothing to clear'
\endif
SQL
    ;;

  check)
    echo "Clerk sign-up mode: $(sign_up_mode)   (want: restricted)"
    find_user
    if [[ -z $USER_ID ]]; then echo "no Clerk user $DEMO_EMAIL"; exit 1; fi
    clerk GET "/users/$USER_ID"
    json '`account ${j.id}: delete_self_enabled=${j.delete_self_enabled} create_organization_enabled=${j.create_organization_enabled} emails=${j.email_addresses.length} last_sign_in=${j.last_sign_in_at ? new Date(j.last_sign_in_at).toISOString() : "never"}`'
    ;;
esac
