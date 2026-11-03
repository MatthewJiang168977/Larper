#!/usr/bin/env bash
# scripts/pg-tag.sh: the Postgres tag follows infra/postgres's contents, not the commit,
# so deploys that don't change the image don't restart Postgres.
set -euo pipefail
here=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/scripts" "$tmp/infra"
cp "$here/scripts/pg-tag.sh" "$tmp/scripts/"
cp -R "$here/infra/postgres" "$tmp/infra/"
tag() { bash "$tmp/scripts/pg-tag.sh"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

a=$(tag)
[[ $a =~ ^17-[0-9a-f]{12}$ ]] || fail "tag $a isn't 17-<12 hex>"
[[ $(tag) == "$a" ]] || fail "same contents, different tag"
[[ $(cd "$here" && bash scripts/pg-tag.sh) == "$a" ]] || fail "copy and repo disagree"

echo '# touched' >> "$tmp/infra/postgres/Dockerfile"
b=$(tag); [[ $b != "$a" ]] || fail "Dockerfile edit kept the tag"

echo x > "$tmp/infra/postgres/extra.conf"
c=$(tag); [[ $c != "$b" ]] || fail "new file in the build context kept the tag"
mv "$tmp/infra/postgres/extra.conf" "$tmp/infra/postgres/other.conf"
[[ $(tag) != "$c" ]] || fail "renamed file kept the tag"
rm "$tmp/infra/postgres/other.conf"
[[ $(tag) == "$b" ]] || fail "removing the file didn't restore the tag"

sed -i.bak 's/postgresql:17-/postgresql:18-/' "$tmp/infra/postgres/Dockerfile"; rm -f "$tmp/infra/postgres/Dockerfile.bak"
[[ $(tag) == 18-* ]] || fail "major not read from the Dockerfile"

sed -i.bak 's/^FROM .*/FROM debian:bookworm/' "$tmp/infra/postgres/Dockerfile"; rm -f "$tmp/infra/postgres/Dockerfile.bak"
if tag >/dev/null 2>&1; then fail "no major should fail"; fi
echo "pg-tag: all checks passed"
