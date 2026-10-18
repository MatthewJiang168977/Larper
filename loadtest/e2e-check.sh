#!/usr/bin/env bash
# End-to-end check of the running stack, as one signed-in test user:
#   1. quests: GET /quests/today near Washington Square returns a quest
#   2. events: accept it, check in at the place, and the taste-worker applies the
#      events (taste_profiles.source = 'events', updated after the check-in)
#   3. ingest: GET /quests/today somewhere not yet ingested (INGEST_AT, default White
#      Plains) enqueues an ingest; the ingest-worker loads it and the next request gets a
#      quest there
#
#   loadtest/e2e-check.sh                 # reads CLERK_SECRET_KEY from apps/web/.env.local
#   BASE_URL=http://localhost:8080 USER_EMAIL=loadtest-cold+0@example.com loadtest/e2e-check.sh
#
# Uses a Clerk dev-instance test user (created by the load tests). Leaves the quest
# completed and the new area ingested.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1

BASE_URL=${BASE_URL:-http://localhost:8080}
USER_EMAIL=${USER_EMAIL:-loadtest-cold+0@example.com}
INGEST_AT=${INGEST_AT:-41.0340,-73.7629} # lat,lng outside the NYC extract
INGEST_Q="lat=${INGEST_AT%,*}&lng=${INGEST_AT#*,}"
NS=${NS:-larper}
[[ -n "${CLERK_SECRET_KEY:-}" ]] ||
  CLERK_SECRET_KEY=$(grep -E '^CLERK_SECRET_KEY=' apps/web/.env.local 2>/dev/null | cut -d= -f2- | tr -d '"\r')
: "${CLERK_SECRET_KEY:?set CLERK_SECRET_KEY (or put it in apps/web/.env.local)}"
FAILED=0
ok() { echo "  ok: $*"; }
fail() { echo "  FAIL: $*"; FAILED=1; }
json() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const v=(function(){return $1})();process.stdout.write(v===undefined||v===null?'':String(v))})"; }
clerk() { curl -s -X "$1" "https://api.clerk.com/v1$2" -H "Authorization: Bearer $CLERK_SECRET_KEY" -H 'Content-Type: application/json' ${3:+-d "$3"}; }
psql() { kubectl -n "$NS" exec pg-1 -c postgres -- psql -U postgres -d larper -Atc "$1"; }

CLERK_USER=$(clerk GET "/users?email_address=$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$USER_EMAIL")" |
  json "JSON.parse(d)[0]?.id")
[[ -n $CLERK_USER ]] || { echo "no Clerk user $USER_EMAIL (run a load test once to create it)"; exit 1; }
SESSION=$(clerk POST /sessions "{\"user_id\":\"$CLERK_USER\"}" | json "JSON.parse(d).id")
trap 'clerk POST "/sessions/$SESSION/revoke" >/dev/null' EXIT # nothing is saved, but don't leave it live
token() { clerk POST "/sessions/$SESSION/tokens" | json "JSON.parse(d).jwt"; }
api() { # method path [body] -> body, then "HTTP <code>" on the last line
  curl -s -X "$1" "$BASE_URL$2" -H "Authorization: Bearer $(token)" -H 'Content-Type: application/json' \
    ${3:+-d "$3"} -w '\nHTTP %{http_code}'
}
body() { sed '$d' <<<"$1"; }
code() { tail -1 <<<"$1" | cut -d' ' -f2; }

echo "== 1. quests ($USER_EMAIL)"
r=$(api GET '/quests/today?lat=40.7295&lng=-73.9965')
[[ $(code "$r") == 200 ]] && ok "GET /quests/today: 200" || fail "GET /quests/today: $(code "$r") $(body "$r" | head -c 200)"
Q=$(body "$r")
QID=$(json "JSON.parse(d).quest?.id" <<<"$Q")
STATUS=$(json "JSON.parse(d).quest?.status" <<<"$Q")
PLAT=$(json "JSON.parse(d).quest?.place.lat" <<<"$Q")
PLNG=$(json "JSON.parse(d).quest?.place.lng" <<<"$Q")
NAME=$(json "JSON.parse(d).quest?.place.name" <<<"$Q")
DECK=$(json "JSON.parse(d).deck.length" <<<"$Q")
[[ -n $QID ]] && ok "quest $QID ($STATUS): $NAME; deck of $DECK more" || fail "no quest in the response"

echo "== 2. accept, check in, taste update"
USER_ID=$(psql "SELECT id FROM users WHERE clerk_id = '$CLERK_USER'")
before=$(psql "SELECT count(*) FROM processed_events WHERE consumer = 'taste-worker'")
t0=$(psql "SELECT now()")
if [[ $STATUS == offered ]]; then
  r=$(api POST "/quests/$QID/accept")
  [[ $(code "$r") =~ ^20[01]$ ]] && ok "accept: $(code "$r")" || fail "accept: $(code "$r") $(body "$r" | head -c 200)"
fi
r=$(api POST "/quests/$QID/complete" "{\"lat\":$PLAT,\"lng\":$PLNG,\"accuracy\":10}")
[[ $(code "$r") =~ ^20[01]$ ]] && ok "check in at the place: $(code "$r")" || fail "check in: $(code "$r") $(body "$r" | head -c 200)"
applied=
for _ in $(seq 1 30); do
  applied=$(psql "SELECT count(*) FROM taste_profiles WHERE user_id = $USER_ID AND source = 'events' AND updated_at > '$t0'")
  [[ $applied == 1 ]] && break; sleep 2
done
after=$(psql "SELECT count(*) FROM processed_events WHERE consumer = 'taste-worker'")
[[ $applied == 1 ]] && ok "taste-worker applied the events: taste_profiles updated, processed_events $before -> $after" ||
  fail "taste profile not updated by events within 60 s (processed_events $before -> $after)"
unsent=$(psql "SELECT count(*) FROM outbox WHERE sent_at IS NULL")
[[ $unsent == 0 ]] && ok "outbox drained" || fail "$unsent outbox rows unsent"

echo "== 3. ingest ($INGEST_AT)"
areas0=$(psql "SELECT count(*) FROM areas_ingested")
r=$(api GET "/quests/today?$INGEST_Q")
pending=$(body "$r" | json "(JSON.parse(d).surveying?.pending || []).join(' ')")
if [[ -n $pending ]]; then
  ok "survey started for: $pending"
  start=$(date +%s)
  for _ in $(seq 1 60); do
    sleep 10
    r=$(api GET "/quests/today?$INGEST_Q")
    pending=$(body "$r" | json "(JSON.parse(d).surveying?.pending || []).join(' ')")
    [[ -z $pending ]] && break
  done
  [[ -z $pending ]] && ok "ingested in $(( $(date +%s) - start )) s" || fail "still surveying after 10 min: $pending"
else
  echo "  (area already ingested: nothing to survey)"
fi
quest=$(body "$r" | json "JSON.parse(d).quest?.place.name")
[[ -n $quest ]] && ok "quest in the new area: $quest" || fail "no quest in the new area"
echo "  areas_ingested: $areas0 -> $(psql "SELECT count(*) FROM areas_ingested");" \
  "jobs: $(psql "SELECT string_agg(status || '=' || n, ' ') FROM (SELECT status, count(*) n FROM jobs GROUP BY 1 ORDER BY 1) s")"

[[ $FAILED == 0 ]] && echo "== all checks passed" || { echo "== some checks FAILED"; exit 1; }
