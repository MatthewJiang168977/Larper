#!/usr/bin/env bash
# Deletes every Clerk user with an email address starting with "loadtest"
# (loadtest+N@, loadtest-cold+N@, ...) on the instance of CLERK_SECRET_KEY in
# apps/web/.env.local. Lists them first and asks you to type "yes".
#
#   scripts/clerk-cleanup-loadtest-users.sh    # from the repo folder (Git Bash on Windows)
#
# The secret key is only passed to curl in a header; it is never printed.
set -uo pipefail

ENV_FILE=apps/web/.env.local
API=https://api.clerk.com/v1
DELAY=${DELAY:-0.2} # seconds between deletes (Clerk's Backend API rate limit)

[[ -f $ENV_FILE ]] || { echo "no $ENV_FILE: run this from the repo folder" >&2; exit 1; }
KEY=$(grep -E '^CLERK_SECRET_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'\r ')
[[ -n $KEY ]] || { echo "CLERK_SECRET_KEY not found in $ENV_FILE" >&2; exit 1; }
[[ $KEY == sk_test_* ]] || { echo "CLERK_SECRET_KEY is not a development key (sk_test_...); refusing" >&2; exit 1; }

# clerk METHOD PATH -> response body in $BODY, HTTP status in $STATUS. Retries 429s.
# Call it directly, not in $(...): a subshell's variables don't come back.
STATUS=000 BODY=
clerk() {
  local out attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    out=$(curl -sS -X "$1" "$API$2" -H "Authorization: Bearer $KEY" -w $'\n%{http_code}') || { STATUS=000; BODY=; return 1; }
    STATUS=${out##*$'\n'}
    BODY=${out%$'\n'*}
    if [[ $STATUS == 429 ]]; then sleep 2; continue; fi
    return 0
  done
  return 1
}

# Every user with an email starting with "loadtest", as "id email" lines.
# email_address_query matches anywhere in the address, so filter for the prefix here.
list_loadtest_users() {
  local offset=0 page lines
  while :; do
    clerk GET "/users?email_address_query=loadtest&limit=500&offset=$offset&order_by=created_at"
    [[ $STATUS == 200 ]] || { echo "listing users failed: HTTP $STATUS" >&2; return 1; }
    page=$BODY
    # Prints "id email" per match, then "#page <number of users in this page>".
    lines=$(node -e '
      let d = "";
      process.stdin.on("data", (c) => (d += c)).on("end", () => {
        const users = JSON.parse(d);
        for (const u of users) {
          const emails = (u.email_addresses || []).map((e) => e.email_address);
          const match = emails.find((e) => e.toLowerCase().startsWith("loadtest"));
          if (match) console.log(u.id + " " + match);
        }
        console.log("#page " + users.length);
      });' <<<"$page") || { echo "could not parse the user list" >&2; return 1; }
    grep -v '^#page ' <<<"$lines"
    (( $(grep '^#page ' <<<"$lines" | cut -d' ' -f2) < 500 )) && break
    offset=$((offset + 500))
  done
}

total_users() {
  local body
  clerk GET /users/count
  [[ $STATUS == 200 ]] && node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).total_count))' <<<"$BODY" || echo "?"
}

USERS=$(list_loadtest_users) || exit 1
COUNT=$(grep -c . <<<"$USERS")
echo "Clerk users in total: $(total_users)"
echo "Users whose email starts with \"loadtest\": $COUNT"
if (( COUNT == 0 )); then echo "nothing to delete"; exit 0; fi
cut -d' ' -f2 <<<"$USERS" | sed 's/^/  /'

echo
answer=
read -r -p "Delete these $COUNT users? Type yes to confirm: " answer </dev/tty || echo
[[ $answer == yes ]] || { echo "not confirmed; nothing deleted"; exit 0; }

deleted=0 failed=0
while read -r id email; do
  [[ -n $id ]] || continue
  clerk DELETE "/users/$id"
  if [[ $STATUS == 200 ]]; then
    deleted=$((deleted + 1)); echo "  deleted $email"
  else
    failed=$((failed + 1)); echo "  FAILED $email (HTTP $STATUS)"
  fi
  sleep "$DELAY"
done <<<"$USERS"

LEFT=$(list_loadtest_users | grep -c .)
echo
echo "Deleted $deleted, failed $failed."
echo "loadtest users remaining: $LEFT"
echo "Clerk users remaining in total: $(total_users)"
