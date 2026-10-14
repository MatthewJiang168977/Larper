# 0001: Size the API's CPU request from measurement, and drop its CPU limit

- **Status:** accepted, 2026-10-13
- **Scope:** `api` Deployment and HPA in `infra/helm/larper`, Postgres resources
- **Evidence:** `loadtest/results/hpa-*` (k3d, k6 on the same laptop)

## Context

The API autoscales on CPU. The chart shipped with:

```yaml
resources:
  requests: { cpu: 100m }
  limits:   { cpu: 500m }
hpa: { minReplicas: 2, maxReplicas: 6, targetCPU: 70 }
```

An HPA CPU target is a percentage **of the request**, so 70% of 100m means "add a replica when
a pod averages more than **70m**". Nobody had checked what a pod actually uses. The 100m was a
placeholder, and 70% is the number everyone copies.

## How it was found

Watching the first k6 ramp, the HPA went 2 → 6 almost immediately and then sat at 6 while
latency kept climbing. That looked like the autoscaler working. A light, constant 20-VU run
([before-low](../../loadtest/results/hpa-before-low-20261013-134354/report.md)) said otherwise:

- At **~19 req/s total**, with p95 at 162 ms, it scaled 2 → 4 in 39 s, then to 6.
- Six pods served the load two pods had been serving fine. The HPA had no replicas left for an
  actual peak.

`loadtest/hpa-run.sh` was written for this: it runs k6 and records the HPA and the per-pod CPU
every 5 s, and `hpa-report.js` lines up load, replicas, CPU and latency.

## Measuring the real need

A sizing run with the HPA off and 2 fixed pods, holding 20, 40, 60, 80 and 100 VUs for 90 s each
([sizing](../../loadtest/results/hpa-sizing-20261013-211748/report.md)):

| req/s per pod | CPU per pod | p50 | p95 | |
|---|---|---|---|---|
| 9.3 | 290m | 38 ms | 190 ms | healthy |
| 17.8 | 425m | 58 ms | 398 ms | p95 doubled |
| 24.0 | 479m | 213 ms | 552 ms | at the 500m limit |
| 26.5 | 496m | 436 ms | 1,168 ms | at the limit |
| 25.0 | 497m | 915 ms | 1,987 ms | at the limit, throughput flat |

- **A pod needs ~290m at a comfortable load**, about 3× the request it had. The HPA's
  threshold (70m) was a quarter of that.
- **Saturation:** p95 holds to ~9 req/s per pod and has doubled by ~18. Under the 500m limit,
  a pod tops out at ~25 req/s however much load arrives; the rest queues.
- Postgres stayed at 230–250m and Redis at ~20m throughout, so the API is the bottleneck.

## Options tested

All four ramps are the same 8-minute k6 script (to 200 VUs, hold 4 min), from 2 replicas.

| | Baseline | (a) | (b) | (c) |
|---|---|---|---|---|
| CPU request | 100m | 300m | 300m | 300m |
| CPU limit | 500m | 500m | **none** | none |
| HPA target | 70% (70m) | 75% (225m) | 75% (225m) | **60% (180m)** |
| Scale-up behavior | default | default | default | **+200% / +4 pods per 15 s** |
| First scale-up | 38 VUs, ~23 req/s | 72 VUs, ~38 req/s | 63 VUs, ~41 req/s | 39 VUs, ~25 req/s |
| Requests | 41,208 | 43,467 | 55,838 | 65,044 |
| Errors | 0 | 0 | 0 | 0 |
| p50 / p95 / p99 (whole run) | 360 ms / 2.44 s / 4.96 s | 303 ms / 2.29 s / 4.07 s | 87 ms / 484 ms / 1.43 s | **31 ms / 161 ms / 385 ms** |
| At 200 VUs: throughput | 105 req/s | 120 req/s | 156 req/s | **183 req/s** |
| At 200 VUs: p95 | 3.25 s | 2.62 s | 507 ms | **164 ms** |
| At 200 VUs: CPU per pod | 484m (at limit) | 486m (at limit) | 686m | 660m |
| k6 thresholds (p95 < 800 ms) | fail | fail | pass | pass |

Reports: [baseline](../../loadtest/results/hpa-before-ramp-20261013-212721/report.md),
[(a)](../../loadtest/results/hpa-after-ramp-a-limit-20261013-215156/report.md),
[(b)](../../loadtest/results/hpa-after-ramp-b-nolimit-20261013-223117/report.md),
[(c)](../../loadtest/results/hpa-after-ramp-c-fast60-20261013-224443/report.md).

**(a) fixes the scaling decision, not the peak.** With a real request, the HPA waits until pods
are actually busy (twice the load before the first scale-up). But at 200 VUs all six pods still
sit at their 500m limit, and p95 swings between 1 and 4.7 s. Six pods capped at half a core each
are ~3 cores of API, and that's the ceiling.

**(b) shows the limit was the problem.** Same request, no CPU limit: 30% more throughput at peak,
p95 down from 2.6 s to 0.5 s, and the first run to pass the 800 ms threshold. Pods averaged 686m
with bursts above 1 core. A CPU limit is enforced by CFS quota in 100 ms periods: a Node.js
process that bursts past 50 ms of CPU in a period is paused for the rest of it, and every request
in flight waits. That shows up as p95 spikes long before average CPU looks full. The memory limit
stays: running out of memory is fatal, running out of CPU only slows a pod down.

**(c) scales out ahead of the load.** At 60% (180m per pod) the first scale-up comes at the same
load as the baseline's (~25 req/s), but now that means "pods are at ~60% of what they need", not
"pods are at 70m". It had 3 pods at 30 s, 5 at 60 s and 6 by 90 s, against (b)'s 2, 3 and 6.
During the ramp (30–120 s) its p95 stayed at 95–139 ms, where (b)'s was 160–385 ms. Two caveats
keep this honest:

- **The 60% target did the work, not the scale-up policy.** Kubernetes' default already allows
  +100% or +4 pods per 15 s with no stabilization window, so from 2 pods the explicit policy
  allows the same +4. What limits scale-out is the loop around it: metrics-server samples every
  15 s, the HPA re-evaluates every 15 s and sizes from `current CPU / target`, and new pods take
  ~20 s to pass readiness. A lower target starts that loop earlier. The policy stays in the chart
  because it's what was tested and it states the intent, but it's not why (c) won.
- **The plateau gap between (b) and (c) is mostly noise.** At 200 VUs both ran 6 unlimited pods
  for over four minutes, so they're the same system there; 156 vs 183 req/s and 507 vs 164 ms
  p95 is the run-to-run variance of a laptop running k6 and three k3d nodes at once. The ramp-phase
  difference is real, because there the two configs had different numbers of pods.

## Decision

Ship (c), the config that was tested:

```yaml
api:
  resources:
    requests: { cpu: 300m, memory: 128Mi }   # measured: ~290m at a comfortable 9 req/s per pod
    limits:   { memory: 256Mi }              # no CPU limit: CFS throttling caused the p95 swings
  hpa:
    minReplicas: 2
    maxReplicas: 6
    targetCPU: 60                            # 180m per pod: scale out before the ~12-18 req/s knee
    behavior:
      scaleUp:
        stabilizationWindowSeconds: 0
        selectPolicy: Max
        policies:
          - { type: Percent, value: 200, periodSeconds: 15 }
          - { type: Pods, value: 4, periodSeconds: 15 }
```

- **Request = measured need.** It's what a pod uses at the load where p95 is still flat, so the
  scheduler reserves what a pod actually needs, and the HPA's percentage means something.
- **Target 60%, not 70–80%.** By the sizing curve, 180m is crossed at ~5–6 req/s per pod. In
  the ramp, though, the first scale-up landed at ~12 req/s per pod (25 req/s on 2 pods): the
  15 s metrics + 15 s HPA + ~20 s readiness loop is close to a minute, and the load keeps
  climbing meanwhile. At 75%, (a)/(b) first scaled at ~19–20 req/s per pod, already past the
  ~12–18 req/s knee. The lower target buys back that minute. The cost is more replicas at
  moderate load, which on EKS means the Karpenter node arrives sooner (see below).
- **No CPU limit, memory limit kept,** for the reasons in (b).
- **Postgres gets requests** (`250m`, `256Mi`, memory limit `1Gi`). It had none, which made it
  `BestEffort`: first to be evicted under memory pressure, and almost no CPU share under
  contention. That was harmless on a 20-thread laptop; with API pods that can now burst, it
  would starve the database on a 2-vCPU node.
- The chart no longer sets `spec.replicas` while the HPA is on (Helm 4's server-side apply
  failed on the field the HPA owns, leaving a half-applied release).

## Trade-off: replicas per node

The scheduler places pods by their **requests**, not their usage. A low request packs more pods
onto a node than the node can serve; an honest request spreads them out and makes the cluster
grow.

On EKS (one `t4g.large`, ~1,930m allocatable; estimates from the chart's requests, to be
confirmed by `eks-up.sh`'s per-node report):

| | Non-API requests on node 1 | Free for the API | API pods on node 1 | What happens at 6 replicas |
|---|---|---|---|---|
| 100m request | ~1,100m (EKS system ~450m + stack, Postgres BestEffort) | ~800m | 6+ | All 6 on one 2-vCPU node; they need ~4 cores, so they throttle each other. Karpenter never sees a reason to add a node. |
| 300m request | ~1,360m (incl. Postgres 250m) | ~570m | 1 | Replica 2 already lands on a Karpenter node; that node takes the other ~5 (≈1,750m free / 300m). Max 6 fits in 2 nodes, which is the NodePool's limit. |

- The honest request costs a second node for the whole demo: ≈ +$0.074/h, about $0.22 over a
  3-hour session. In exchange, the scale-out is real: pods get the CPU the scheduler promised them,
  and Karpenter's node shows up because the cluster actually needed it.
- A 250m request would fit 2 API pods on node 1 and delay the second node, at the price of
  under-reserving what a pod uses at its comfortable load. Not worth $0.07/h.
- Without a CPU limit, a pod can borrow idle CPU on its node but is only guaranteed its request.
  Every neighbor must therefore have a request too (hence the Postgres change). Monitoring keeps
  hard CPU limits so it can never compete with the app it measures.

## Lessons for the write-up

- **Check the arithmetic of the target.** `averageUtilization` is relative to the request, so a
  placeholder request silently turns a reasonable-looking target into a wrong one.
- **Measure before tuning.** One fixed-replica sizing run gave the CPU-per-pod curve and the
  saturation point; everything else followed from it.
- **CPU limits hurt latency-sensitive services.** The throttling showed up as p95 swings, not
  as errors or as high average CPU.
- **Keep the test environment clean.** A Grafana crash loop (OOM at 256Mi, ~9 cores per restart,
  no CPU limit) contaminated two runs on the same node; they are kept, marked `CONTAMINATED.md`,
  and were repeated. An early "12m CPU per req/s" figure was metrics-server lag in the first 30 s
  of a run, not a real number.
- **Helm gotcha:** with `--reuse-values`, `--set ...cpu=null` does not remove a limit that comes
  from the chart's defaults. A values file with `cpu: null` (without `--reuse-values`) does.

## Caveats

- k6 runs on the same machine as k3d, so absolute numbers include the laptop competing with
  itself. The comparison between runs is fair (same machine, same script, same data); absolute
  throughput should come from the EKS run.
- One run per config, and plateau p95 on this laptop varies a lot between runs ((b) and (c) are
  the same system at 200 VUs and differ ~3×). The limit-vs-no-limit conclusion doesn't rest on
  p95 alone: with the limit, every pod sat at 480–500m for the whole plateau and throughput
  stopped growing, which is the throttling mechanism itself. The EKS run repeats (c) on
  dedicated nodes.
