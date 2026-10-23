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
