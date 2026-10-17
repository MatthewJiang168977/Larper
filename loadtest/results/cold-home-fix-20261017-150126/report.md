# HPA run: cold-home-fix-20261017-150126

API resources: requests {"cpu":"300m","memory":"128Mi"}, limits {"memory":"256Mi"}.
HPA: 2–6 replicas, target 60% of the CPU request (= 180m per pod), behavior {"scaleDown":{"policies":[{"periodSeconds":15,"type":"Percent","value":100}],"selectPolicy":"Max"},"scaleUp":{"policies":[{"periodSeconds":15,"type":"Percent","value":200},{"periodSeconds":15,"type":"Pods","value":4}],"selectPolicy":"Max","stabilizationWindowSeconds":0}}.

20875 requests, 0.00% failed, p50 62 ms, p95 165 ms, p99 237 ms.
First scale-up (2 → 6) 59 s in, at 99 VUs / ~67 req/s.
Max replicas: 6.

| t (s) | VUs | req/s | p95 (ms) | errors | replicas | CPU/pod (m) | API CPU total (m) | CPU per req/s (m) |
|---|---|---|---|---|---|---|---|---|
| 0 | 48 | 22.7 | 198 | 0.0% | 2 | 55 | 110 | 4.9 |
| 30 | 99 | 67.9 | 231 | 0.0% | 6 | 1007 | 2014 | 29.7 |
| 60 | 100 | 93.4 | 134 | 0.0% | 6 | 802 | 4811 | 51.5 |
| 90 | 100 | 93.3 | 148 | 0.0% | 6 | 752 | 4511 | 48.4 |
| 120 | 100 | 93.8 | 143 | 0.0% | 6 | 766 | 4597 | 49.0 |
| 150 | 100 | 92.8 | 165 | 0.0% | 6 | 755 | 4530 | 48.8 |
| 180 | 100 | 93.6 | 144 | 0.0% | 6 | 768 | 4610 | 49.2 |
| 210 | 100 | 91.7 | 169 | 0.0% | 6 | 766 | 4597 | 50.2 |
| 240 | 100 | 46.7 | 168 | 0.0% | 6 | 740 | 4441 | 95.0 |

## Load levels

| VUs | req/s | replicas | req/s per pod | p50 (ms) | p95 (ms) | p99 (ms) | errors | CPU/pod (m) | CPU per req/s (m) | Postgres CPU (m) | Redis CPU (m) | |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 93.1 | 6.0 | 15.5 | 59 | 151 | 217 | 0.0% | 765 | 49.3 | 2865 | 88 |  |


## Cache

| cache | hits | misses | errors | hit rate |
|---|---|---|---|---|
| area | 19577 | 1273 | 0 | 93.9% |
| deck | 25 | 20850 | 0 | 0.1% |

Re-onboards during the run (taste_profiles upserts): 404.
Ingest jobs before / after: 4 / 4. Cells: 863 cells, 437 home cells.
