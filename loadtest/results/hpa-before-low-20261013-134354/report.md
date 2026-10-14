# HPA run: hpa-before-low-20261013-134354

API resources: requests {"cpu":"100m","memory":"128Mi"}, limits {"cpu":"500m","memory":"256Mi"}.
HPA: 2–6 replicas, target 70% of the CPU request (= 70m per pod), behavior Kubernetes defaults.

3365 requests, 0.00% failed, p50 33 ms, p95 162 ms, p99 504 ms.
First scale-up (2 → 4) 39 s in, at 20 VUs / ~19 req/s.
Max replicas: 6.

| t (s) | VUs | req/s | p95 (ms) | errors | replicas | CPU/pod (m) | API CPU total (m) | CPU per req/s (m) |
|---|---|---|---|---|---|---|---|---|
| 0 | 20 | 19.7 | 317 | 0.0% | 2 | 114 | 229 | 11.6 |
| 30 | 20 | 18.6 | 200 | 0.0% | 6 | 207 | 993 | 53.4 |
| 60 | 20 | 19.2 | 122 | 0.0% | 6 | 171 | 1023 | 53.3 |
| 90 | 20 | 19.1 | 125 | 0.0% | 6 | 107 | 640 | 33.6 |
| 120 | 20 | 18.9 | 140 | 0.0% | 6 | 132 | 794 | 42.0 |
| 150 | 20 | 16.7 | 129 | 0.0% | 6 | 137 | 820 | 49.0 |

## Load levels

| VUs | req/s | replicas | req/s per pod | p50 (ms) | p95 (ms) | p99 (ms) | errors | CPU/pod (m) | CPU per req/s (m) | Postgres CPU (m) | Redis CPU (m) | |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 20 | 19.0 | 5.3 | 3.6 | 34 | 131 | 338 | 0.0% | 149 | 41.5 | – | – |  |

