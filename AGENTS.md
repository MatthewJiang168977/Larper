# Working on Larper (coding agents)

The rules for working in this repository are in [CLAUDE.md](CLAUDE.md). Read it first
and follow it. It applies to every coding agent, not only Claude.

This file adds limits for agents other than Claude Code. Where it is stricter than
CLAUDE.md, follow this file. Nothing here loosens CLAUDE.md.

## Never

- **Production.** Don't change, deploy to or clean up anything live: the Oracle VM
  (`larper-k3s`) and the Oracle tenancy, Clerk, Vercel, DNS (Cloudflare),
  playlarper.com or api.playlarper.com.
- **The VM and the cloud tools.** Don't run `ssh` to the VM, `kubectl`, `helm` or
  `oci`, not even the read-only commands CLAUDE.md allows. Ask the user to run the
  check and paste the output.
- **Live scripts.** Don't run `scripts/oci-*.sh` (including `--resize-check` and
  `--close`) or `scripts/demo-account.sh` (including `check`).
- **`main`.** Never commit to or push to `main`, and never force-push. Work on a
  branch and open a pull request.
- **Merging.** Never merge a pull request, including your own or a revert. CLAUDE.md's
  "Merging your own PRs" section does not apply to you: the user merges every PR.

If a task seems to need any of these, stop and say what you'd run and why. The user
decides and runs it.

## Allowed

- Reading and changing code on a branch, running the tests, lint and typecheck, and
  pushing that branch.
- Database tests against the local stack or CI only, never production.
- `gh` for pull requests: create, view, diff, checks. Not `gh pr merge`.

## End of session

Give the user the digest CLAUDE.md describes: what changed, decisions you made and
why, anything surprising, and anything waiting on the user.
