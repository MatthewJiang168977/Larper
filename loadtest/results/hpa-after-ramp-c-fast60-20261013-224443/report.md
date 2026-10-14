# HPA run: hpa-after-ramp-c-fast60-20261013-224443

API resources: requests {"cpu":"300m","memory":"128Mi"}, limits {"memory":"256Mi"}.
HPA: 2–6 replicas, target 60% of the CPU request (= 180m per pod), behavior {"scaleDown":{"policies":[{"periodSeconds":15,"type":"Percent","value":100}],"selectPolicy":"Max"},"scaleUp":{"policies":[{"periodSeconds":15,"type":"Percent","value":200},{"periodSeconds":15,"type":"Pods","value":4}],"selectPolicy":"Max","stabilizationWindowSeconds":0}}.

65044 requests, 0.00% failed, p50 31 ms, p95 161 ms, p99 385 ms.
First scale-up (2 → 3) 45 s in, at 39 VUs / ~25 req/s.
Max replicas: 6.

| t (s) | VUs | req/s | p95 (ms) | errors | replicas | CPU/pod (m) | API CPU total (m) | CPU per req/s (m) |
|---|---|---|---|---|---|---|---|---|
| 0 | 26 | 13.0 | 134 | 0.0% | 2 | 55 | 111 | 8.5 |
| 30 | 51 | 36.6 | 95 | 0.0% | 3 | 284 | 738 | 20.2 |
| 60 | 89 | 67.4 | 101 | 0.0% | 5 | 340 | 1360 | 20.2 |
| 90 | 126 | 102.2 | 127 | 0.0% | 6 | 338 | 2026 | 19.8 |
| 120 | 164 | 136.1 | 139 | 0.0% | 6 | 430 | 2578 | 18.9 |
| 150 | 200 | 167.5 | 202 | 0.0% | 6 | 546 | 3275 | 19.6 |
| 180 | 200 | 184.2 | 195 | 0.0% | 6 | 683 | 4097 | 22.2 |
| 210 | 200 | 180.1 | 228 | 0.0% | 6 | 690 | 4140 | 23.0 |
| 240 | 200 | 174.5 | 192 | 0.0% | 6 | 636 | 3817 | 21.9 |
| 270 | 200 | 172.1 | 229 | 0.0% | 6 | 621 | 3724 | 21.6 |
| 300 | 200 | 188.1 | 133 | 0.0% | 6 | 598 | 3590 | 19.1 |
| 330 | 200 | 188.5 | 126 | 0.0% | 6 | 671 | 4024 | 21.3 |
| 360 | 200 | 188.1 | 129 | 0.0% | 6 | 669 | 4011 | 21.3 |
| 390 | 200 | 189.8 | 105 | 0.0% | 6 | 680 | 4081 | 21.5 |
| 420 | 195 | 135.8 | 136 | 0.0% | 6 | 619 | 3713 | 27.3 |
| 450 | 94 | 44.1 | 74 | 0.0% | 6 | 416 | 2498 | 56.6 |

## Load levels

| VUs | req/s | replicas | req/s per pod | p50 (ms) | p95 (ms) | p99 (ms) | errors | CPU/pod (m) | CPU per req/s (m) | Postgres CPU (m) | Redis CPU (m) | |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 200 | 183.2 | 6.0 | 30.5 | 32 | 164 | 447 | 0.0% | 660 | 21.6 | 814 | 60 |  |

