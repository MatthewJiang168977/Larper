#!/usr/bin/env bash
# One-time setup for .github/workflows/oci-probe.yml: makes a NEW OCI API key just for
# GitHub Actions (your laptop key never leaves the laptop), uploads its public half to
# your OCI user, and stores what the workflow needs as repo secrets.
#
#   scripts/oci-ci-secrets.sh
#   NTFY_TOPIC=some-long-random-name scripts/oci-ci-secrets.sh   # also phone pushes
#
# Needs: the OCI CLI configured (~/.oci/config), gh logged in (gh auth login), openssl.
# Nothing secret is printed. The CI private key exists on disk only until it's stored
# in GitHub, then it's deleted. Revoke it any time: OCI Console -> your profile ->
# API keys (fingerprint printed below), or `oci iam user api-key delete`.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO=${REPO:-MatthewJiang168977/Larper}
CONFIG=${OCI_CLI_CONFIG_FILE:-$HOME/.oci/config}
SSH_PUB=${SSH_PUB:-$HOME/.ssh/larper_oci.pub}

conf() { awk -F' *= *' -v k="$1" '/^\[DEFAULT\]/{d=1;next} /^\[/{d=0} d&&$1==k{print $2}' "$CONFIG"; }
USER_OCID=$(conf user)
TENANCY_OCID=$(conf tenancy)
[[ -n "$USER_OCID" && -n "$TENANCY_OCID" ]] || { echo "no user/tenancy in $CONFIG [DEFAULT]" >&2; exit 1; }
[[ -s "$SSH_PUB" ]] || { echo "no SSH public key at $SSH_PUB (the local probe creates it)" >&2; exit 1; }
command -v gh >/dev/null || { echo "gh not found: winget install GitHub.cli, then gh auth login" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not logged in: gh auth login" >&2; exit 1; }

# OCI allows 3 API keys per user.
keys=$(oci iam user api-key list --user-id "$USER_OCID" --query 'length(data)' --raw-output)
(( keys < 3 )) || { echo "your OCI user already has 3 API keys; delete one first" >&2; exit 1; }

umask 077
DIR=$(mktemp -d)
trap 'rm -f -- "$DIR/ci_key.pem" "$DIR/ci_key_public.pem"; rmdir -- "$DIR" 2>/dev/null || true' EXIT
openssl genrsa -out "$DIR/ci_key.pem" 2048 2>/dev/null
openssl rsa -in "$DIR/ci_key.pem" -pubout -out "$DIR/ci_key_public.pem" 2>/dev/null

# The CLI is a Windows program under Git Bash: hand it a Windows path.
pub=$(cygpath -w "$DIR/ci_key_public.pem" 2>/dev/null || echo "$DIR/ci_key_public.pem")
FINGERPRINT=$(oci iam user api-key upload --user-id "$USER_OCID" --key-file "$pub" \
                --query 'data.fingerprint' --raw-output)
echo "uploaded CI API key, fingerprint $FINGERPRINT (not a secret; it identifies the key)"

# Values go through stdin, never the command line.
set_secret() { printf '%s' "$2" | gh secret set "$1" --repo "$REPO" >/dev/null && echo "set $1"; }
set_secret OCI_USER_OCID "$USER_OCID"
set_secret OCI_TENANCY_OCID "$TENANCY_OCID"
set_secret OCI_FINGERPRINT "$FINGERPRINT"
gh secret set OCI_API_KEY --repo "$REPO" <"$DIR/ci_key.pem" >/dev/null && echo "set OCI_API_KEY"
gh secret set OCI_SSH_PUBLIC_KEY --repo "$REPO" <"$SSH_PUB" >/dev/null && echo "set OCI_SSH_PUBLIC_KEY"
[[ -n "${NTFY_TOPIC:-}" ]] && set_secret NTFY_TOPIC "$NTFY_TOPIC"

echo "done; the CI private key is stored only in GitHub now. Test: gh workflow run oci-probe.yml --repo $REPO"
