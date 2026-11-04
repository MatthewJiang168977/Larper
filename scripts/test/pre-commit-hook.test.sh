#!/usr/bin/env bash
# .githooks/pre-commit: blocks a commit that adds a secret, lets a clean one through,
# and doesn't trip on what .gitleaks.toml allows. Needs Docker (as the hook does).
set -euo pipefail
here=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

cd "$tmp"
git init -q .
git config user.email test@example.com && git config user.name test
mkdir -p .githooks scripts
cp "$here/.githooks/pre-commit" .githooks/
cp "$here/scripts/secret-scan.sh" scripts/
cp "$here/.gitleaks.toml" .
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks
git add -A && git commit -q -m base || fail "the hook blocked the clean base commit"

# Built at runtime, so this file holds no secret itself.
key="sk_""live_51Habcdefghijklmnopqrstuv""WXyz0123456789"
printf 'STRIPE_KEY="%s"\n' "$key" >leak.env
git add leak.env
if git commit -q -m leak 2>"$tmp/err"; then fail "a staged secret got committed"; fi
grep -q "commit blocked" "$tmp/err" || fail "no 'commit blocked' message: $(cat "$tmp/err")"
git rm -q --cached leak.env && rm leak.env

echo 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlcmsuZXhhbXBsZS5jb20k' >public.env
echo 'hello' >notes.txt
git add -A
git commit -q -m clean 2>"$tmp/err" || fail "a clean commit (with an allowed publishable key) was blocked: $(cat "$tmp/err")"

git rm -q notes.txt
git commit -q -m delete || fail "a deletion-only commit was blocked"

echo "pre-commit hook: ok"
