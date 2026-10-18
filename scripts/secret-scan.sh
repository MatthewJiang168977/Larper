#!/usr/bin/env bash
# The secret scan CI runs (job "secrets"), for before a commit:
#   - gitleaks with .gitleaks.toml: the staged changes (default), or the whole history
#   - loadtest/redact.js --check: no Clerk session IDs, tokens or k6 setup_data in results
#
#   scripts/secret-scan.sh            # staged changes
#   scripts/secret-scan.sh --history  # every commit (what CI scans)
#
# Runs gitleaks from its Docker image, pinned to the same digest as CI.
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1 # Git Bash: leave /repo alone

IMAGE=zricethezav/gitleaks:v8.21.2@sha256:0e99e8821643ea5b235718642b93bb32486af9c8162c8b8731f7cbdc951a7f46
mode=${1:-staged}
case $mode in
  staged) scan='gitleaks protect --staged --source /repo --config /repo/.gitleaks.toml --redact --no-banner -v' ;;
  --history) scan='gitleaks detect --source /repo --config /repo/.gitleaks.toml --redact --no-banner -v' ;;
  *) echo "usage: $0 [--history]" >&2; exit 2 ;;
esac

repo=$(pwd -W 2>/dev/null || pwd) # a Windows path for Docker Desktop under Git Bash
# The checkout belongs to another user than the container's: tell git it's fine.
docker run --rm -v "$repo:/repo" --entrypoint sh "$IMAGE" \
  -c "git config --global --add safe.directory /repo && $scan"
node loadtest/redact.js --check loadtest/results
echo "secret scan: clean"
