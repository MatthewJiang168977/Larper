# HPA run: cold-relocate-final-20261017-140429

API resources: requests {"cpu":"300m","memory":"128Mi"}, limits {"memory":"256Mi"}.
HPA: 2–6 replicas, target 60% of the CPU request (= 180m per pod), behavior {"scaleDown":{"policies":[{"periodSeconds":15,"type":"Percent","value":100}],"selectPolicy":"Max"},"scaleUp":{"policies":[{"periodSeconds":15,"type":"Percent","value":200},{"periodSeconds":15,"type":"Pods","value":4}],"selectPolicy":"Max","stabilizationWindowSeconds":0}}.

21126 requests, 0.00% failed, p50 51 ms, p95 143 ms, p99 202 ms.
No scale-up (stayed at 6 replicas).
Max replicas: 6.

| t (s) | VUs | req/s | p95 (ms) | errors | replicas | CPU/pod (m) | API CPU total (m) | CPU per req/s (m) |
|---|---|---|---|---|---|---|---|---|
| 0 | 50 | 25.1 | 158 | 0.0% | 6 | 47 | 281 | 11.2 |
| 30 | 100 | 73.4 | 126 | 0.0% | 6 | 285 | 1710 | 23.3 |
| 60 | 100 | 93.7 | 141 | 0.0% | 6 | 459 | 2755 | 29.4 |
| 90 | 100 | 94.3 | 133 | 0.0% | 6 | 528 | 3165 | 33.6 |
| 120 | 100 | 92.8 | 144 | 0.0% | 6 | 526 | 3156 | 34.0 |
| 150 | 100 | 93.6 | 141 | 0.0% | 6 | 525 | 3153 | 33.7 |
| 180 | 100 | 93.2 | 147 | 0.0% | 6 | 529 | 3173 | 34.0 |
| 210 | 100 | 93.3 | 160 | 0.0% | 6 | 547 | 3282 | 35.2 |
| 240 | 98 | 44.8 | 135 | 0.0% | 6 | 485 | 2912 | 65.0 |

## Load levels

| VUs | req/s | replicas | req/s per pod | p50 (ms) | p95 (ms) | p99 (ms) | errors | CPU/pod (m) | CPU per req/s (m) | Postgres CPU (m) | Redis CPU (m) | |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 93.4 | 6.0 | 15.6 | 52 | 146 | 208 | 0.0% | 528 | 33.9 | 3662 | 93 |  |


## Cache

| cache | hits | misses | errors | hit rate |
|---|---|---|---|---|
| area | 14669 | 5905 | 0 | 71.3% |
| deck | 552 | 20574 | 0 | 2.6% |

Re-onboards during the run (taste_profiles upserts): 0.
Ingest jobs before / after: 4 / 4. Cells: 863 cells, 437 home cells.
