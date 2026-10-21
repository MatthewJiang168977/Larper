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

- **Two firewalls, both SSH-only.**
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
    except port 22, and all new inbound UDP. Whatever Kubernetes opens later stays
    closed.
  - Bootstrap refuses to write rules that drop SSH or open any other port, validates
    them with `iptables-restore --test`, and arms a 3-minute automatic rollback that
    `oci-up.sh` cancels only after a *new* SSH connection succeeds. The firewall is the
    bootstrap's last step (after the k3s install), so the window only has to cover that
    reconnect; the rollback restarts k3s too, since restoring the rules flushes its
    chains.
  - Nothing else is reachable: the k3s API (6443), the kubelet (10250), Traefik
    (80/443) and NodePorts are closed; kubectl and the app go through SSH tunnels.
    Public access comes later through a Cloudflare Tunnel (outbound only), not by
    opening ports.
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
