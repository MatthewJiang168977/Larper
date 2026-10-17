# Oracle Always Free target: k3s on one A1 VM

The whole stack on a single Ampere A1 VM (2 OCPU / 12 GB, arm64, Ubuntu 24.04) in
us-sanjose-1, at $0. The VM comes from `scripts/oci-capacity-probe.sh` (or its GitHub
Actions twin), this folder prepares it, and `scripts/oci-up.sh` deploys.

## What runs where (all Always Free)

| Resource | Always Free limit | Used |
|---|---|---|
| A1 compute | 4 OCPU / 24 GB total | 2 OCPU / 12 GB |
| Boot volume | 200 GB total block storage | 50 GB |
| VCN, internet gateway, security list | free | 1 each |
| Object Storage (backups) | 20 GB, 50k API requests/month | bucket `larper-pg-backups`, ~1–2 GB, a few k requests (below) |
| Public IPv4 | 1 ephemeral per instance | 1 |

The account is Free Tier (not pay-as-you-go), so it can't be billed; going over a limit
makes that request fail instead.

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
- **Credentials:** an OCI "Customer Secret Key" (S3-compatible, 2 per user), created
  by `oci-up.sh` and kept in `~/.oci/larper-pg-backup-s3.env` (mode 600) and in the
  Secret `pg-backup-s3`. Keep the file: a rebuild needs it (or a new key).

Status: `kubectl -n larper get backup` (one per run, `completed`), and
`kubectl -n larper get cluster pg -o jsonpath='{.status.conditions}'`
(`ContinuousArchiving` = True).

## Deploy

```bash
scripts/oci-capacity-probe.sh   # once the VM exists: saves its address to ~/larper-oci-instance.env
scripts/oci-up.sh               # bootstrap + images + operators + app (~20–30 min the first time)
```

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
`larper-pg-backup` key in the console (Profile → Customer secret keys) and let
`oci-up.sh` create a new one.

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
infra/oci-k3s/test/run.sh down      # remove it all (the VM may use up to 12 GB of memory)
```

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

## Not verified yet

- Anything specific to the real VM: arm64 images on A1 (built and checked separately,
  not deployed), Oracle's S3 endpoint (path-style addressing), and the VCN.
- A k3s restart on the real VM. On the stand-in it's verified (above); an actual
  k3s version upgrade (new binary) hasn't been run anywhere.
- The restore drill above, on the real bucket.
