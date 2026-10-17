# HPA run: hpa-eks-20261017-000510

API resources: requests {"cpu":"300m","memory":"128Mi"}, limits {"memory":"256Mi"}.
HPA: 2–6 replicas, target 60% of the CPU request (= 180m per pod), behavior {"scaleDown":{"policies":[{"periodSeconds":15,"type":"Percent","value":100}],"selectPolicy":"Max"},"scaleUp":{"policies":[{"periodSeconds":15,"type":"Percent","value":200},{"periodSeconds":15,"type":"Pods","value":4}],"selectPolicy":"Max","stabilizationWindowSeconds":0}}.

65715 requests, 0.00% failed, p50 42 ms, p95 187 ms, p99 568 ms.
First scale-up (2 → 3) 75 s in, at 70 VUs / ~51 req/s.
Max replicas: 6.

| t (s) | VUs | req/s | p95 (ms) | errors | replicas | CPU/pod (m) | API CPU total (m) | CPU per req/s (m) |
|---|---|---|---|---|---|---|---|---|
| 0 | 25 | 12.7 | 148 | 0.0% | 2 | 45 | 91 | 7.1 |
| 30 | 50 | 36.1 | 139 | 0.0% | 2 | 169 | 338 | 9.4 |
| 60 | 88 | 67.9 | 77 | 0.0% | 3 | 271 | 633 | 9.3 |
| 90 | 125 | 103.0 | 98 | 0.0% | 3 | 318 | 954 | 9.3 |
| 120 | 163 | 131.2 | 374 | 0.0% | 6 | 371 | 1482 | 11.3 |
| 150 | 200 | 168.7 | 189 | 0.0% | 6 | 306 | 1836 | 10.9 |
| 180 | 200 | 186.8 | 151 | 0.0% | 6 | 334 | 2004 | 10.7 |
| 210 | 200 | 185.0 | 196 | 0.0% | 6 | 333 | 1998 | 10.8 |
| 240 | 200 | 188.0 | 145 | 0.0% | 6 | 335 | 2011 | 10.7 |
| 270 | 200 | 185.9 | 171 | 0.0% | 6 | 314 | 1884 | 10.1 |
| 300 | 200 | 186.1 | 186 | 0.0% | 6 | 316 | 1894 | 10.2 |
| 330 | 200 | 185.2 | 228 | 0.0% | 6 | 314 | 1886 | 10.2 |
| 360 | 200 | 187.1 | 142 | 0.0% | 6 | 307 | 1843 | 9.8 |
| 390 | 200 | 187.0 | 144 | 0.0% | 6 | 310 | 1857 | 9.9 |
| 420 | 196 | 134.5 | 269 | 0.0% | 6 | 298 | 1788 | 13.3 |
| 450 | 96 | 45.3 | 53 | 0.0% | 6 | 210 | 1258 | 27.8 |

## Load levels

| VUs | req/s | replicas | req/s per pod | p50 (ms) | p95 (ms) | p99 (ms) | errors | CPU/pod (m) | CPU per req/s (m) | Postgres CPU (m) | Redis CPU (m) | |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 200 | 186.2 | 6.0 | 31.0 | 43 | 183 | 568 | 0.0% | 320 | 10.3 | 448 | 30 |  |

