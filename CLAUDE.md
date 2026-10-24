# Working on Larper

## Live systems: propose first, wait for approval

Anything that changes a live system must be proposed and wait for explicit approval
before it runs. **That includes cleanup.** The live systems are:

- **The Oracle VM** (`larper-k3s`): deploys (`scripts/oci-up.sh`), resizes, reboots,
  anything run over SSH or through its kubectl that writes (apply, delete, scale,
  rollout restart, `create job`), and container image removal or pruning.
- **The Oracle tenancy**: instances, quotas, budgets, security lists, users and
  policies, Object Storage buckets, objects and keys.
- **Clerk**: users, sessions, sign-in tokens, instance settings (including
  `scripts/demo-account.sh create` and `reset`).
- **Vercel**: projects, environment variables, deployments, domains.
- **DNS** (Cloudflare): records and settings.

A proposal says:
- what will change, and the exact command;
- what it affects, such as downtime, data, cost or visitors;
- how to undo it.

Approval covers that one proposal. It doesn't extend to related or follow-up changes,
or to the same change later.

**Read-only checks are fine without asking**:
- `--resize-check`, `scripts/demo-account.sh check`;
- `oci ... get` and `list`, capacity reports;
- `kubectl get`, `describe`, `logs` and `top`;
- `curl` against the public API;
- outside port scans.

A check must not write anything: no `create job`, no backups, no test sessions.
When unsure whether something writes, treat it as a change and ask.

## Merging your own PRs

You may merge a PR you opened only when **all** of these hold:

- CI is green on the PR's current head commit (check the run for that exact SHA;
  `gh pr checks` can show an older run).
- An independent reviewer subagent, one that didn't write any of the code, has
  reviewed that same commit and approved it.
- It touches none of:
  - database migrations (`db/migrations/`);
  - auth, Clerk or the demo account (`apps/api/src/auth/`, `apps/api/src/demo/`,
    `apps/api/src/ops/demo-reset.ts`, sign-in/sign-up and the demo button in
    `apps/web`, `scripts/demo-account.sh`);
  - security: rate limits, CORS, secret scanning, redaction, database roles and
    grants;
  - `scripts/oci-up.sh` and the scripts it runs;
  - the Helm chart (`infra/helm/`) and its values files;
  - the firewall (`infra/oci-k3s/bootstrap.sh`);
  - Terraform (`infra/terraform/`);
  - dependencies: any `package.json`, `pnpm-lock.yaml`, `go.mod` or `go.sum`;
  - CI (`.github/`);
- It makes no user-facing product decision (copy, flows, what the app shows or
  offers).

Everything else waits for the user. When unsure whether a PR qualifies, it doesn't.

The reviewer is `.claude/agents/code-reviewer.md`. Give it the PR number, its head
SHA and the plan the PR was meant to carry out. Its approval counts only for the
commit it reviewed: a new push needs a new review.

Merging is not deploying. A merge never permits a change to a live system; the
approval rule above still applies to every deploy.

**Reverts.** If a PR you merged under this rule breaks production, you may revert
it at once: open a revert PR and merge it without waiting for CI or the reviewer.
Then tell the user right away: what broke, how you saw it, and the revert PR. The
revert only changes `main`. Redeploying the reverted code is still a live change
and needs approval.

## End-of-session digest

At the end of each session, give the user a short digest:

- what merged;
- decisions you made, and why;
- anything surprising;
- anything waiting on the user.
