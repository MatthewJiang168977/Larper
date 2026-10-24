# Oracle Always Free target: k3s on one A1 VM

The whole stack on a single Ampere A1 VM (1 OCPU / 6 GB, arm64, Ubuntu 24.04) in
us-sanjose-1, at $0, running the [demo profile](../../README.md#demo-profile-one-small-vm)
(`values-oci.yaml` + `values-demo.yaml`), which fits in 4 GB. The VM comes from
`scripts/oci-capacity-probe.sh` (or its GitHub Actions twin), this folder prepares it,
and `scripts/oci-up.sh` deploys.

The probe used to ask for 2 OCPU / 12 GB, which is now the whole Always Free A1
allowance: Oracle halved it from 4 OCPU / 24 GB in 2026 (enforced from 18 August). Asking
for half of that is more likely to find room in a region that's usually out of A1
capacity, and leaves the other half free (resizing to 2 / 12 stays at $0; anything above
is billed on a pay-as-you-go account, or refused on a Free Tier one). The probe refuses
to ask for more than 2 / 12.

## What runs where (all Always Free)

| Resource | Always Free limit | Used |
|---|---|---|
| A1 compute | 2 OCPU / 12 GB total (1,500 OCPU-hours, 9,000 GB-hours a month) | 1 OCPU / 6 GB (`VM.Standard.A1.Flex`) |
| Boot volume | 200 GB total block storage | 50 GB |
| VCN, internet gateway, security list | free | 1 each |
| Object Storage (backups) | 20 GB, 50k API requests/month | bucket `larper-pg-backups`, ~1–2 GB, a few k requests (below) |
| Public IPv4 | 1 ephemeral per instance | 1 |

On a Free Tier account going over a limit makes the request fail. A pay-as-you-go
account bills it instead, so the guards below cap the tenancy at the Always Free amounts
either way.

## Cost and access guards

Set up once, by hand, in the tenancy (2026-10-21). Check them with the commands shown.

- **Quota policy `larper-free-tier-caps`** (root compartment). These are hard caps:
  anything over them is refused, on Free Tier and pay-as-you-go alike.
  ```
  zero compute-core quotas in tenancy
  set compute-core quota standard-a1-core-count to 2 in tenancy
  zero compute-memory quotas in tenancy
  set compute-memory quota standard-a1-memory-count to 12 in tenancy
  set block-storage quota total-storage-gb to 200 in tenancy
  set block-storage quota backup-count to 5 in tenancy
  set object-storage quota storage-bytes to 21474836480 in tenancy
  set vcn quota reserved-public-ip-count to 0 in tenancy
  zero load-balancer quotas in tenancy
  zero network-load-balancer-api quotas in tenancy
  zero database quotas in tenancy
  zero filesystem quotas in tenancy
  zero container-engine quotas in tenancy
  ```
  The effective cap and usage for any limit:
  `oci limits resource-availability get -c <tenancy> --service-name compute --limit-name standard-a1-core-count --availability-domain <AD>`.
  A resize to 2 OCPU / 12 GB still fits; a second A1 instance at that size doesn't.
- **Budget `larper-guard`:** $1 a month, alerting at 1% of actual spend and 100% of
  forecast spend.
- **User `larper-ci`** (group `larper-ci`, policy `larper-ci`):
  - Capabilities: customer secret keys only, so its S3 key is the only credential it
    can have. No API keys, console password, auth tokens, SMTP, DB or OAuth
    credentials, so it can't sign in to the console even if its activation email is
    used, and nobody can add an API key to it without first changing that.
  - Its policy is all it can do:
    `read buckets` and `manage objects`, both `where target.bucket.name = 'larper-pg-backups'`.
  - CNPG's S3 key is a customer secret key on this user (`oci-up.sh`, `BACKUP_USER`),
    so a leaked cluster Secret reaches the backup bucket and nothing else.
- **No instance principals:** no dynamic groups and no policies for them, so nothing
  on the VM can call OCI APIs as the VM. Check: `oci iam dynamic-group list -c <tenancy>`
  (empty).
- **No admin keys outside the laptop:** the GitHub probe's API key (on the admin user)
  was deleted and the repo's `OCI_*` secrets removed once the instance existed. If the
  probe is ever needed again (the runbook below), give it a key on a user of its own,
  with only instance and network rights, not an admin key.
- **Backups:**
  - CNPG keeps 14 days (`postgres.backup.retention`).
  - The bucket (private, Standard tier, versioning off) has a lifecycle policy that
    aborts multipart uploads left unfinished for 1 day and deletes objects older than
    60 days.
  - The 60-day rule is a backstop for what retention doesn't cover, such as an old
    server folder after a rebuild. It also means that if backups silently stopped for 60
    days, the last good one would be deleted, hence the alert in "To do".
  - Policy `larper-objectstorage-lifecycle` lets Object Storage run the rules:
    `Allow service objectstorage-us-sanjose-1 to manage object-family in tenancy where target.bucket.name = 'larper-pg-backups'`.
  - Check: `oci os object-lifecycle-policy get --bucket-name larper-pg-backups`.

## Security

- **Two firewalls, both SSH-only** (plus HTTP and HTTPS when public: see "Going public").
  - VCN security list (cloud side, from the probe): inbound TCP 22 and ICMP 3/4
    (path-MTU discovery) only.
  - Host iptables (`bootstrap.sh`): Oracle's image rules already allow only SSH, but end
    INPUT and FORWARD with REJECT, which also breaks k3s pod traffic. Bootstrap keeps
    Oracle's rules (including the 169.254.x instance-services rules, which keep
    non-root processes off the metadata service) and replaces those REJECTs with: accept
    the pod network (10.42.0.0/16), then DROP.
  - Those filter rules can't stop traffic Kubernetes forwards to a pod: k3s's service
    load balancer (Traefik's 80/443), NodePorts and hostPorts are DNATed in
    `nat PREROUTING`, and kube-router and kube-proxy ACCEPT that traffic in `FORWARD`
    before our rules see it. So a guard in `mangle PREROUTING`, which runs before
    both, drops every new TCP connection to the node from outside the pod network
    except port 22 (22, 80 and 443 with `PUBLIC=1`), and all new inbound UDP. Whatever
    else Kubernetes opens later stays closed.
  - Bootstrap refuses to write rules that drop SSH, open any other INPUT port, or let the
    guard pass anything but those ports, validates
    them with `iptables-restore --test`, and arms a 3-minute automatic rollback that
    `oci-up.sh` cancels only after a *new* SSH connection succeeds. The firewall is the
    bootstrap's last step (after the k3s install), so the window only has to cover that
    reconnect; the rollback restarts k3s too, since restoring the rules flushes its
    chains.
  - Nothing else is reachable: the k3s API (6443), the kubelet (10250), NodePorts and
    Traefik's own ports (8080 dashboard, off; 9100 metrics) are closed, and so are
    80/443 unless the demo is public. kubectl goes through an SSH tunnel.
- **SSH:** keys only (`~/.ssh/larper_oci`), no passwords, no root login, 3 auth tries.
- **Updates:** everything at bootstrap, then `unattended-upgrades` installs security
  updates daily and reboots at 04:30 when a kernel update needs it. k3s and all pods
  come back on their own; expect a few minutes of downtime on those nights.
- **k3s:** pinned version, secrets encrypted at rest.

## Backups

CloudNativePG's Barman Cloud plugin streams WAL and weekly base backups to Object
Storage through its S3-compatible API. (The plugin, not CNPG's built-in
`barmanObjectStore`: that is deprecated, and our CNPG `standard` image doesn't ship the
`barman-cloud` tools. The plugin runs them in a sidecar; it needs cert-manager.)

- **Where:** `s3://larper-pg-backups/<serverName>/`, `serverName` = `pg` for the first
  cluster, `pg-2`, `pg-3`, ... after each rebuild.
- **What:** WAL continuously (a segment ships when full or after `archive_timeout`, 1 h),
  a base backup weekly (Sunday 03:00 UTC) plus one right after the cluster is created,
  gzip-compressed, kept 14 days.
- **Recovery point:** at most ~1 h of writes lost (the archive timeout). Lower it in
  `values.yaml` (`postgres.backup.archiveTimeout`) at the cost of more requests.
- **Free-tier budget:**
  - Storage: up to 3 base backups (≈ the compressed database, a few hundred MB for NYC)
    plus 14 days of WAL. Expect 1–2 GB of the 20 GB.
  - Requests: an idle database ships ~720 WAL segments a month at a 1 h timeout, a few
    requests each, plus the weekly base backups and retention cleanup: low thousands
    a month of the 50k. CNPG's default 5 min timeout would be ~8,600 segments a month,
    which is why it's raised.
  - Check: `oci os bucket get --bucket-name larper-pg-backups --fields approximateSize,approximateCount`
- **Credentials:** an OCI "Customer Secret Key" (S3-compatible, 2 per user) on the
  user `larper-ci` (see "Cost and access guards"), created by `oci-up.sh` and kept in `~/.oci/larper-pg-backup-s3.env` (mode 600) and in the
  Secret `pg-backup-s3`. Keep the file: a rebuild needs it (or a new key).

Status: `kubectl -n larper get backup` (one per run, `completed`), and
`kubectl -n larper get cluster pg -o jsonpath='{.status.conditions}'`
(`ContinuousArchiving` = True).

## Deploy

```bash
scripts/oci-capacity-probe.sh   # once the VM exists: saves its address to ~/larper-oci-instance.env
scripts/oci-up.sh               # bootstrap + images + operators + app (~20–30 min the first time)
MONITORING=1 scripts/oci-up.sh  # the same, plus Prometheus + Grafana (~0.8 GiB more; fits in 6 GB)
```

`oci-up.sh` deploys the chart with `-f values-oci.yaml -f values-demo.yaml`. The demo layer
comes last, so it sets the sizes: 1 API replica (HPA max 2), one taste-worker and one
ingest-worker, smaller Postgres, Redpanda and DuckDB, and monitoring off. `values-oci.yaml`
alone is sized for 2 OCPU and doesn't fit this VM's CPU requests.

**CPU is the tight part, not memory.** An A1 OCPU is one Ampere core, so this VM has one
vCPU, half the 2 vCPU the demo profile was sized for. On k3d (a laptop's x86 cores, three
nodes) the whole cluster (pods and k3s) used about 0.3 core idle and 0.6 core on average at 8 req/s (8× the demo's load). It
peaked at ~1.9 cores at 8 req/s and ~3 cores during an area ingest. On one core, those
peaks get spread out instead: expect an ingest of a new area to take longer than the ~56 s
measured on k3d, and slower responses while it runs.

If it's too slow, resize in place. The instance stays, with its disk and IP, and it
reboots. That also needs Oracle to have the capacity, so it can fail the same way a
launch does.

```bash
oci compute instance update --instance-id <id> --shape-config '{"ocpus": 2, "memoryInGBs": 12}'
```

To launch at another size in the first place, run `OCPUS=2 MEMORY_GB=12
scripts/oci-capacity-probe.sh`, or change `OCPUS` / `MEMORY_GB` in `oci-probe.yml`.

Then load the place data (repo README, "Load place data", against the
`larper-oci` context through the tunnel `oci-up.sh` prints).

## Restore drill (do it once after the first base backup)

A backup you've never restored is a hope, not a backup. With the API tunnel open:

```bash
kubectl -n larper apply -f - <<'EOF'
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata: { name: pg-drill }
spec:
  instances: 1
  imageName: <the image from: kubectl -n larper get cluster pg -o jsonpath='{.spec.imageName}'>
  storage: { size: 4Gi }
  bootstrap: { recovery: { source: origin } }
  externalClusters:
    - name: origin
      plugin:
        name: barman-cloud.cloudnative-pg.io
        parameters: { barmanObjectName: pg-backups, serverName: pg }
EOF
kubectl -n larper wait cluster/pg-drill --for=condition=Ready --timeout=20m
kubectl -n larper exec pg-drill-1 -- psql -U postgres -d larper -Atc 'select count(*) from places'
kubectl -n larper exec pg-1       -- psql -U postgres -d larper -Atc 'select count(*) from places'
kubectl -n larper delete cluster pg-drill   # read-only drill: it never writes to the bucket
```

## Runbook: the VM was reclaimed or lost

Oracle can stop an Always Free instance it considers idle (CPU, network and memory all
under 20% for 7 days) and may terminate capacity in rare cases. Data on the VM (k3s,
Postgres volume) goes with a terminated instance; the bucket survives.

**1. Stopped or gone?**

```bash
oci compute instance list --compartment-id <tenancy> --display-name larper-k3s \
  --query 'data[].{state:"lifecycle-state",id:id}' --output table
```

- **STOPPED** (idle reclamation): start it, nothing is lost:
  `oci compute instance action --action START --instance-id <id>`, then
  `scripts/oci-capacity-probe.sh` to refresh `~/larper-oci-instance.env` (the public IP
  may have changed).
- **TERMINATED or missing:** rebuild (below). Expect: as long as a new VM takes to get,
  plus ~30 min; up to ~1 h of writes lost.

**2. Keep what the rebuild needs.** Don't delete the bucket `larper-pg-backups`, and
keep `~/.oci/larper-pg-backup-s3.env`. If that file is gone, delete the old
`larper-pg-backup` key (`oci iam customer-secret-key list --user-id <larper-ci's id>`,
then `delete`) and let `oci-up.sh` create a new one.

**3. Find the newest backup folder** (the `serverName` the lost cluster wrote to):

```bash
oci os object list --bucket-name larper-pg-backups --delimiter / --query 'prefixes' --raw-output
# e.g. ["pg/"] after the first rebuild, ["pg/", "pg-2/"] after the second: take the highest
```

**4. Get a new VM.** Clear the old address, then probe:

```bash
ssh-keygen -R <old public IP>
rm ~/larper-oci-instance.env
scripts/oci-capacity-probe.sh    # or re-enable the GitHub workflow and the cron-job.org trigger
```

**5. Deploy with restore.** `RESTORE_FROM` is the folder from step 3; `SERVER_NAME` is a
new, unused folder for the rebuilt cluster's own backups (never the same: the restored
cluster must not write into the backup it came from):

```bash
RESTORE_FROM=pg SERVER_NAME=pg-2 scripts/oci-up.sh
```

**6. Verify.**

```bash
kubectl -n larper get cluster pg                         # Cluster in healthy state
kubectl -n larper exec pg-1 -- psql -U postgres -d larper -Atc 'select count(*) from places'
kubectl -n larper get backup                             # first base backup into pg-2 completed
curl -s localhost:8081/healthz                           # through the traefik port-forward
```

Later runs of `oci-up.sh` (no variables) keep writing to `pg-2` and keep the restore
settings, so they don't disturb the cluster.

**7. Clean up, once `pg-2` has a completed base backup you trust:** the old folder isn't
covered by retention (only the running cluster's is), so delete it by hand to free the
space:

```bash
oci os object bulk-delete --bucket-name larper-pg-backups --prefix pg/ --dry-run   # check the list first
oci os object bulk-delete --bucket-name larper-pg-backups --prefix pg/
```

## Local rehearsal

`test/run.sh` runs the real `scripts/oci-up.sh` against a stand-in VM: a privileged
Ubuntu 24.04 container booting systemd, with Oracle's stock iptables rules and a
cloud-init sshd drop-in that turns passwords on. SeaweedFS stands in for Object Storage,
and jobs use the real SQS queue.

```bash
infra/oci-k3s/test/run.sh up        # stand-in VM + S3, oci-up.sh, then checks (~20 min)
infra/oci-k3s/test/run.sh reboot    # restart the VM (as after an unattended-upgrades reboot), check again
infra/oci-k3s/test/run.sh k3s-restart  # re-apply the firewall + restart k3s under requests, check again
infra/oci-k3s/test/run.sh restore   # new VM, empty disks, restore Postgres from the last backup folder
infra/oci-k3s/test/run.sh public    # the public deploy (PUBLIC_HOST, no certificate): 80/443 open, then visitor checks
infra/oci-k3s/test/run.sh close     # oci-up.sh --close, then checks that only SSH is reachable
infra/oci-k3s/test/run.sh down      # remove it all
```

The stand-in VM is capped like the real one: 1 CPU and 6 GB (`VM_CPUS` and `VM_MEMORY`
override; the rehearsals up to 2026-10-17 ran at 2 CPU / 12 GB with the full profile).

Passed on 2026-10-18 at that size, with the demo profile (`up`, fresh VM): every check
above. Right after the deploy (no place data loaded yet, so Postgres is small), the VM
held 2.3 GiB of its 6 GiB, k3s itself 0.86 GiB of it. CPU requests summed to 570m of the
one core, and idle use ran 0.2–0.35 core. The stand-in's CPU cap is a quota, so the
kubelet still sees the host's cores: it shows that the stack runs within one core, but it
can't show the scheduler refusing a pod that wouldn't fit. Loading NYC's places adds
~0.3 GiB of Postgres cache (the README's demo measurements).

The checks: sshd's effective config and a refused password login, the rollback
disarmed, ports from a neighbour on the network (22 open; 6443, 10250, 80, 443 and
Traefik's NodePorts closed), every pod running, the API's `/readyz` through Traefik,
the base backup and WAL archiving, and after a restore the marker row written before
the old VM was removed.

Passed on 2026-10-16: fresh bootstrap, re-running `oci-up.sh`, a reboot, and a
restore chain (`pg` → `pg-2` → `pg-3`). Along the way it found the Postgres image tag
CloudNativePG rejects (now `17-<commit>`, `scripts/pg-tag.sh`), the open Traefik
ports (the mangle guard), a restore that pointed the app at an empty database, and
Git Bash rewriting `/readyz`-style arguments.

Passed on 2026-10-17: restarting k3s on a busy node (`k3s-restart`). With the whole
stack and monitoring running and a `/readyz` request every 0.2 s from the VM through
Traefik, it re-applied the firewall exactly as `bootstrap.sh` does on a change
(`iptables-restore`, which flushes k3s's chains, then `systemctl restart k3s`, the same
restart a k3s upgrade does). All 250 requests across the restart returned 200; no app
container restarted (only the CloudNativePG operator and its backup plugin, which exit
by design when they can't renew their leader lease while the API server is down, and
came back on their own); the mangle guard was still in place; and every check above
passed afterwards. The earlier stand-in that broke here shared the host's cgroup
namespace; with `--cgroupns=private` the kubelet keeps track of running containers.

## The public demo: region and accounts

**Ingest region.** On this target a visitor's location triggers an area ingest only in New York City.
- `api.ingestRegion` in `values-oci.yaml` is the five boroughs, the same box `data/extract_overture.py` uses.
- Each ingest is an Overture download, about a minute of the single core, and rows that stay in Postgres.
- An area at the edge counts if any part of it is inside the box (`apps/api/src/quests/ingest-region.ts`).
- Elsewhere the API serves whatever is already loaded, usually nothing. It reports the skipped areas as `surveying.outside`, and the web app says the demo covers New York City, with a button to the demo spot.
- The chart's default is empty (ingest anywhere), for local development.

**Sign-ups are restricted.**
- Clerk's sign-up mode is Restricted (dashboard → Configure → Restrictions), so only invited users can register.
- The web app hides the sign-in form's "Sign up" link when `NEXT_PUBLIC_SIGNUP_MODE=restricted` is set (Vercel).
- `scripts/demo-account.sh check` shows the mode, read from Clerk's public environment endpoint.

**The demo account.** One shared Clerk user that every visitor signs in as with **Try the demo**: the landing page's main button, and a panel on the sign-in page, whenever `NEXT_PUBLIC_SIGNUP_MODE=restricted`.
- **How it signs in:** the button calls the API's `POST /demo/sign-in`, which asks Clerk's Backend API for a sign-in token for that one user (60 s, single use), and the browser redeems it with Clerk's `signIn.ticket()`. There's no password to show, and no emailed code: the account has no inbox, and a token skips Clerk's new-device check.
- **Limits:** 3 a minute and 10 an hour per client IP, 300 an hour for everyone (docs/decisions/0004). The request has no body: it can only ever sign in as the configured user.
- **What the API needs:** `demo.enabled` (on in `values-oci.yaml`) and the Secret `clerk-demo` (keys `secretKey`, the Clerk secret key, and `userId`). `oci-up.sh` creates it from `apps/web/.env.local` and `~/.oci/larper-demo.env`. Without a `DEMO_USER_ID` the demo is off and `/demo/sign-in` is 404; with one, a missing or malformed Clerk key stops the deploy instead of turning the demo off. Every Secret `oci-up.sh` writes (`aws-sqs`, `pg-backup-s3`, `backup-check`, `clerk-demo`) is read and checked before anything remote changes (`scripts/lib/oci-secrets.sh`). This is the one place a Clerk secret lives in the cluster.
- **Already onboarded, with a baseline taste:** `DEMO_TASTE` (`apps/api/src/demo/demo-account.ts`), as if onboarded with seven vibe cards (noodle counters, dessert worth a line, matcha, hidden bars, live sets, odd museums, crate digging). Visitors' skips and check-ins move it during the day; the reset puts it back.
- **Never an empty map:** for this account only (`/me` says `demo: true`), the web app shows Midtown (Bryant Park) with a short note when location is off or unavailable, or when the API says the spot is outside the demo region. Everyone else keeps Washington Square and the "Outside the demo area" panel.
- **Locked down:** it can't delete itself or create organizations. Before each token the API takes off two-step verification or a lockout, either of which would stop the next visitor.
- **Reset every night** at 04:00 New York time (CronJob `demo-reset`, `apps/api/src/ops/demo-reset.ts`): every session revoked; its one email back as primary; any other email, phone, social login, passkey, wallet, two-step verification, name or picture removed; a new random password nobody knows; its quests deleted; and its taste back to the baseline. That's as the role `larper_demo_reset` (migrations 0012, 0013), which can read users and tags, delete quests and write taste profiles, and nothing else.

```bash
scripts/demo-account.sh create          # once: the user, locked down; its id goes to ~/.oci/larper-demo.env
scripts/demo-account.sh reset           # the nightly reset, now (a Job from the CronJob)
scripts/demo-account.sh check           # sign-up mode and the account's settings
```

## Going public

The API answers on the internet at `https://$PUBLIC_HOST`, served by k3s's Traefik on the
VM. There's no OCI load balancer and no reserved IP: the quotas forbid both.

```bash
cat ~/.oci/larper-public.env          # PUBLIC_HOST, WEB_ORIGIN, ACME_ENV, ACME_EMAIL (never committed)
scripts/oci-up.sh                     # deploys public when PUBLIC_HOST is set
SECURITY_LIST=closed scripts/oci-up.sh  # everything but the cloud edge (to check first)
scripts/oci-up.sh --close             # back to SSH-only: security list, firewall, chart (fast)
```

**What changes:**

- **VCN security list `larper-k3s`:** inbound TCP 80 and 443 from anywhere, added to TCP 22
  and ICMP 3/4. `oci-up.sh` writes the whole rule list (an update replaces it) and does
  nothing if it's already right. Opening happens last, after the chart; closing happens
  first, before anything else.
- **VM firewall (`bootstrap.sh`, `PUBLIC=1`):** the mangle guard passes TCP 22, 80 and 443.
  INPUT stays SSH-only (traffic to Traefik is forwarded, never input), and UDP stays
  dropped.
- **Traefik (k3s HelmChartConfig, `bootstrap.sh`):** `externalTrafficPolicy: Local`, so the
  client's address survives k3s's service load balancer. The dashboard is off, and memory
  is capped at 256 Mi.
- **Chart (`public.enabled`):**
  - The Ingress answers only for `ingress.host`; other names get Traefik's 404.
  - HTTP redirects to HTTPS.
  - cert-manager gets the certificate from Let's Encrypt over HTTP-01 (`public.acme`:
    staging first, then production).
  - Traefik middlewares cap each client address at 20 req/s (burst 60), 30 concurrent
    requests, and 64 KB bodies (413 past that).
  - CORS and Clerk's authorized parties are the web app's origin.
- **Client address:** `api.rateLimit.clientIp: forwarded`. Traefik replaces any
  `X-Forwarded-For` a client sends with the connection's address, and the API believes
  only that. (`cloudflare` would let any client choose its own address with
  `CF-Connecting-IP`.)
- **Health endpoints:** `/healthz` and `/readyz` say nothing about the server (no pod name).

**Reachable from the internet:**

- 22 (SSH, keys only).
- 80: redirects, and cert-manager's challenge.
- 443 at `$PUBLIC_HOST`: the API's routes, all behind a Clerk token except `/healthz` and
  `/readyz`, which are static.
- Nothing else: the checks below and in `test/run.sh public` scan for it.

**If the public IP changes** (it does only if the instance is terminated: an ephemeral IP
"remains assigned" through stop and start, per OCI's docs):

1. Update the DNS A record for `$PUBLIC_HOST`.
2. Refresh `~/larper-oci-instance.env` (`scripts/oci-capacity-probe.sh`) and
   `ssh-keygen -R` the old address.
3. Run `oci-up.sh`. The name doesn't change, so the certificate stays valid.

## Resizing

**The allowance.** Oracle's Always Free A1 allowance is 1,500 OCPU-hours and 9,000 GB-hours a month, "equivalent to 2 OCPUs and 12 GB of memory", for all A1 instances in the tenancy together. Running 2 OCPU / 12 GB all month uses 1,488 and 8,928 (744 h). The quota policy `larper-free-tier-caps` already caps A1 at exactly 2 / 12, so a second A1 instance can't be started while this one holds it all.

```bash
scripts/oci-up.sh --resize-check 2 12   # $0 math, quota and capacity; changes nothing
scripts/oci-up.sh --resize 2 12         # backup, resize (a reboot), then deploy for the new size
scripts/oci-up.sh --resize 1 6          # the way back
```

**Fails closed** (`scripts/test/oci-up-guards.test.sh`, in CI's helm job):
- `--resize-check` hands off to `scripts/oci-resize-check.sh`, which has no deploy code; `oci-up.sh` `exec`s it before anything else runs, so a check can't reach a deploy step whatever the OCI CLI answers.
- The checks (`scripts/lib/oci-resize-preflight.sh`) run in a subshell with `set -euo pipefail`, called as a plain assignment. Every value from the CLI is stripped of CR and checked before any arithmetic.
- `oci-up.sh` deploys only a clean working tree, with no uncommitted or untracked files. `--allow-dirty` overrides it; the local stand-in passes it.

**What `--resize` does:**
1. The checks above. It refuses anything over the allowance, counting every other A1 instance that isn't terminated.
2. A fresh base backup (`pg-before-resize-<time>`) through the VM's own kubectl.
3. `oci compute instance update` with the new OCPUs and memory. Oracle reboots the VM (an ACPI shutdown, so systemd stops k3s and the pods) and keeps its public and private IPs and its volumes. Without capacity or quota, the instance keeps its old size and isn't rebooted.
4. The normal deploy. Its chart profile follows the VM: with 2 CPUs and about 12 GB, `values-oci-a1max.yaml` goes over `values-demo.yaml`.

`bootstrap.sh` sizes Traefik the same way: 512Mi on 12 GB, 256Mi on 6 GB.

**What changes at 2 / 12** (`values-oci-a1max.yaml`):

| | 1 OCPU / 6 GB | 2 OCPU / 12 GB |
|---|---|---|
| API | 1-2 replicas, 100m | 2-4 replicas (never fewer than 2), 150m |
| Postgres | 768Mi limit; shared_buffers 128MB; 50 connections | 3Gi limit; shared_buffers 768MB, effective_cache_size 2GB; 100 connections |
| Role caps | api 15, ingest 12, owner 4 (50 of 50) | api 25, ingest 16, owner 10 (70 of 100) |
| ingest-worker | DuckDB 384MB, 1 thread | DuckDB 1GB, still 1 thread |
| Traefik | 256Mi | 512Mi, 100m request |

The edge's per-client limits (20 req/s, 30 in flight, 64 KB bodies) don't change: they're for abuse, not capacity.

**Downtime:** one window of about 5-8 minutes.
- The reboot and k3s coming back: about 3-5 minutes (the OS boots in about 40 s).
- The deploy then restarts Postgres once for the new `shared_buffers` and `max_connections`: about 1 minute.
- The API keeps 2 replicas from then on, so later rollouts don't take it down.

**Rollback:** `scripts/oci-up.sh --resize 1 6`, the same steps in reverse. The 1 OCPU profile's caps (50 connections) fit the smaller VM again, and the data stays: it's the same boot volume.

## Backup check

The CronJob `backup-check` runs hourly at :17 (`postgres.backup.check`, on in `values-oci.yaml`;
code in `apps/api/src/ops/backup-check.ts`). It asks whether the backups are fresh enough
to restore from, and reports to a dead-man's switch on healthchecks.io.

- **Fresh:** the job pings the URL.
- **Stale:** the job pings `URL/fail` with the reasons, and the Job fails (`kubectl -n larper get jobs`).
- **The check stops running** (VM down, k3s broken, CronJob gone): no pings arrive, and
  healthchecks.io alerts when the period plus grace runs out.

**What counts as stale:**

- **WAL:** the last segment reached the bucket more than **48 h** ago
  (`pg_stat_archiver.last_archived_time`). That is the recovery point.
- **Base backup:** the last one is older than **8 days** (the weekly schedule plus a day),
  read from the Barman Cloud plugin's `ObjectStore` status. The 60-day lifecycle rule
  would eventually delete a base backup that is never replaced.
- A failing archiver is named in the alert, but on its own it doesn't raise one. Postgres
  retries every minute, and a blip clears.

**Why an idle database doesn't false-alarm.** Postgres archives a WAL segment when it
fills, or after `archive_timeout` (1 h) *only if WAL was written since the last switch*.
An idle cluster writes no WAL at all (measured below), so its last archive time would
age without anything being at risk. Each run of the check therefore commits a
transaction with a transaction id (`SELECT pg_current_xact_id()`), which writes a commit
record. `archive_timeout` then ships it within the hour. On a healthy cluster the WAL age
stays under ~2 h however quiet the app is, and only a broken archiver lets it reach 48 h.
That's one 16 MB segment an hour, gzipped to a few KB: the ~720 a month already counted in
"Free-tier budget".

**Setup (once):**

1. On healthchecks.io, create a check with a period of 1 h and a grace of 2 h, and email
   alerts on.
2. Save its ping URL as `pingURL=https://hc-ping.com/<uuid>` in
   `~/.oci/larper-backup-check.env` (mode 600). The URL is a credential: anyone with it can
   ping, so it isn't in the repo.
3. `oci-up.sh` stores it in the Secret `backup-check`. Without the file the check still
   runs and logs, but alerts nobody.

**Its database role, `larper_backup_check`.** It has login, a connection limit of 1, and
**no grant at all**:

- Its two queries need none: `pg_current_xact_id()` and `pg_stat_archiver` are open to
  every role.
- It can't read or write any table.
- It can't create temporary tables (0010 revoked `TEMPORARY` from PUBLIC) and can't create
  anything in a schema.
- Only CloudNativePG's managed roles create it (`templates/postgres.yaml`, password in the
  Secret `pg-backup-check`); no migration touches it.
- `roles.db.spec` checks all of this in CI, running the check's own SQL as the role.

Its Kubernetes service account can only `get` the `pg-backups` ObjectStore.

Check by hand: `kubectl -n larper create job --from=cronjob/backup-check backup-check-now`,
then `kubectl -n larper logs job/backup-check-now` (one `backup-check {...}` line).

## On the real VM (2026-10-21)

First deploy of `oci-up.sh` (demo profile) on the A1 instance (1 OCPU / 6 GB):

- **Health:**
  - Every pod Running.
  - `/healthz` and `/readyz` returned 200 through Traefik over SSH.
  - The CNPG cluster is Ready, with ContinuousArchiving and LastBackupSucceeded both True.
- **Resources (no place data loaded yet):**
  - The VM used 1.75 GiB of its 5.8 GiB, with 4.0 GiB available. k3s itself was 0.8 GiB.
  - CPU was ~0.14 core idle and ~0.4 core during the restore.
  - The boot disk was 17% used.
- **Backups:**
  - The first base backup failed against Oracle's S3 API with `NotImplemented: AWS chunked encoding not supported`.
  - Cause: boto3 1.36+ uses aws-chunked checksums. `values-oci.yaml` now sets `postgres.backup.sidecarEnv` to turn them off.
  - After that, a base backup completed and WAL archived (~5 MB in `pg/`).
- **Restore drill** (the commands above):
  - A marker row was written after the base backup, and its WAL segment archived.
  - `pg-drill` recovered in about a minute, with the marker, the same `places`/`users` counts and migration version as `pg-1`, and the bucket untouched.
  - Then `pg-drill` and the marker were deleted.
- **Restore drill with NYC data:**
  - `load-places` loaded 80,001 places (123 areas) in about a minute, a 143 MB database.
  - The WAL was switched and archived (the bucket grew to ~50 MB), and the drill above was run again.
  - The only base backup was from before the load, so the restore had to replay the whole load from WAL.
  - `pg-drill` was Ready in 77 s.
  - It matched `pg-1` on every check:
    - counts of `places`, `area_stats`, `area_totals`, `areas_ingested`, `tags`
    - MD5 over every place's id, name, tags, `tag_vec` and geometry, and over all of `area_stats`
    - the migration version
    - the 5 nearest places to Washington Square through the GiST index
  - The VM peaked at 3.2 GiB used during the drill, with 4.0 GiB available after it. The bucket was untouched.

## Not verified yet

- A k3s restart on the real VM. On the stand-in it's verified (above); an actual
  k3s version upgrade (new binary) hasn't been run anywhere.
- The weekly scheduled base backup on Oracle (the on-demand one completed; the first
  scheduled one ran before the checksum fix).
