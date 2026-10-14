# HPA run: hpa-after-ramp-c-optimized-20261014-130527

API resources: requests {"cpu":"300m","memory":"128Mi"}, limits {"memory":"256Mi"}.
HPA: 2–6 replicas, target 60% of the CPU request (= 180m per pod), behavior {"scaleDown":{"policies":[{"periodSeconds":15,"type":"Percent","value":100}],"selectPolicy":"Max"},"scaleUp":{"policies":[{"periodSeconds":15,"type":"Percent","value":200},{"periodSeconds":15,"type":"Pods","value":4}],"selectPolicy":"Max","stabilizationWindowSeconds":0}}.

68700 requests, 0.00% failed, p50 20 ms, p95 46 ms, p99 69 ms.
First scale-up (2 → 3) 72 s in, at 66 VUs / ~48 req/s.
Max replicas: 6.

| t (s) | VUs | req/s | p95 (ms) | errors | replicas | CPU/pod (m) | API CPU total (m) | CPU per req/s (m) |
|---|---|---|---|---|---|---|---|---|
| 0 | 25 | 12.7 | 51 | 0.0% | 2 | 15 | 30 | 2.4 |
| 30 | 50 | 37.0 | 38 | 0.0% | 2 | 194 | 388 | 10.5 |
| 60 | 87 | 67.9 | 41 | 0.0% | 4 | 339 | 814 | 12.0 |
| 90 | 125 | 106.0 | 29 | 0.0% | 6 | 335 | 1453 | 13.7 |
| 120 | 162 | 140.8 | 43 | 0.0% | 6 | 356 | 2137 | 15.2 |
| 150 | 200 | 176.4 | 39 | 0.0% | 6 | 489 | 2933 | 16.6 |
| 180 | 200 | 195.7 | 50 | 0.0% | 6 | 555 | 3332 | 17.0 |
| 210 | 200 | 194.6 | 52 | 0.0% | 6 | 619 | 3716 | 19.1 |
| 240 | 200 | 196.4 | 42 | 0.0% | 6 | 589 | 3536 | 18.0 |
| 270 | 200 | 192.1 | 52 | 0.0% | 6 | 508 | 3045 | 15.9 |
| 300 | 200 | 195.0 | 41 | 0.0% | 6 | 558 | 3347 | 17.2 |
| 330 | 200 | 195.9 | 43 | 0.0% | 6 | 558 | 3346 | 17.1 |
| 360 | 200 | 194.3 | 48 | 0.0% | 6 | 563 | 3376 | 17.4 |
| 390 | 200 | 194.2 | 47 | 0.0% | 6 | 574 | 3444 | 17.7 |
| 420 | 199 | 144.2 | 56 | 0.0% | 6 | 557 | 3340 | 23.2 |
| 450 | 98 | 46.7 | 50 | 0.0% | 6 | 381 | 2284 | 48.9 |

## Load levels

| VUs | req/s | replicas | req/s per pod | p50 (ms) | p95 (ms) | p99 (ms) | errors | CPU/pod (m) | CPU per req/s (m) | Postgres CPU (m) | Redis CPU (m) | |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 200 | 194.6 | 6.0 | 32.4 | 21 | 47 | 73 | 0.0% | 566 | 17.5 | 1024 | 80 |  |

