# HPA run: cold-home-final-20261017-135716

API resources: requests {"cpu":"300m","memory":"128Mi"}, limits {"memory":"256Mi"}.
HPA: 2–6 replicas, target 60% of the CPU request (= 180m per pod), behavior {"scaleDown":{"policies":[{"periodSeconds":15,"type":"Percent","value":100}],"selectPolicy":"Max"},"scaleUp":{"policies":[{"periodSeconds":15,"type":"Percent","value":200},{"periodSeconds":15,"type":"Pods","value":4}],"selectPolicy":"Max","stabilizationWindowSeconds":0}}.

20711 requests, 0.00% failed, p50 71 ms, p95 178 ms, p99 264 ms.
First scale-up (2 → 5) 55 s in, at 93 VUs / ~62 req/s.
Max replicas: 6.

| t (s) | VUs | req/s | p95 (ms) | errors | replicas | CPU/pod (m) | API CPU total (m) | CPU per req/s (m) |
|---|---|---|---|---|---|---|---|---|
| 0 | 50 | 24.7 | 157 | 0.0% | 2 | 89 | 178 | 7.2 |
| 30 | 100 | 69.9 | 191 | 0.0% | 5 | 578 | 1155 | 16.5 |
| 60 | 100 | 91.5 | 171 | 0.0% | 6 | 748 | 4037 | 44.1 |
| 90 | 100 | 91.6 | 197 | 0.0% | 6 | 681 | 4084 | 44.6 |
| 120 | 100 | 92.8 | 179 | 0.0% | 6 | 675 | 4053 | 43.7 |
| 150 | 100 | 90.8 | 192 | 0.0% | 6 | 671 | 4023 | 44.3 |
| 180 | 100 | 92.7 | 175 | 0.0% | 6 | 670 | 4020 | 43.3 |
| 210 | 100 | 92.4 | 162 | 0.0% | 6 | 669 | 4015 | 43.5 |
| 240 | 99 | 44.0 | 149 | 0.0% | 6 | 604 | 3627 | 82.5 |

## Load levels

| VUs | req/s | replicas | req/s per pod | p50 (ms) | p95 (ms) | p99 (ms) | errors | CPU/pod (m) | CPU per req/s (m) | Postgres CPU (m) | Redis CPU (m) | |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 92.1 | 6.0 | 15.3 | 70 | 178 | 267 | 0.0% | 677 | 44.1 | 5088 | 81 |  |


## Cache

| cache | hits | misses | errors | hit rate |
|---|---|---|---|---|
| area | 19434 | 1254 | 0 | 93.9% |
| deck | 23 | 20688 | 0 | 0.1% |

Re-onboards during the run (taste_profiles upserts): 403.
Ingest jobs before / after: 4 / 4. Cells: 863 cells, 437 home cells.
