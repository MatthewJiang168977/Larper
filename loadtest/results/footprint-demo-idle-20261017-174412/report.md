# Footprint: demo-idle

15 samples of every pod (kubectl top), 15 of the k3d node containers (docker stats).

| Namespace | CPU mean / peak (m) | Memory mean / peak (Mi) |
|---|---|---|
| cnpg-system | 6 / 7 | 30 / 31 |
| kube-system | 13 / 15 | 82 / 84 |
| larper | 46 / 65 | 642 / 647 |
| monitoring | 43 / 58 | 807 / 810 |
| **all pods except monitoring** | **64 / 81** | **754 / 759** |
| all pods | 108 / 124 | 1561 / 1568 |

k3d node containers (pods + k3s + containerd, 3 nodes): 3357 Mi mean, 3381 Mi peak.

| Pod | CPU mean / peak (m) | Memory mean / peak (Mi) |
|---|---|---|
| cnpg-system/cnpg-cloudnative-pg-84cd4568f9-rw86h | 6 / 7 | 30 / 31 |
| kube-system/coredns-8db54c48d-zn76j | 3 / 4 | 20 / 21 |
| kube-system/local-path-provisioner-5d9d9885bc-5sv7j | 1 / 1 | 8 / 8 |
| kube-system/metrics-server-786d997795-jpbq4 | 7 / 8 | 25 / 26 |
| kube-system/svclb-traefik-328e2cec-448gc | 0 / 0 | 0 / 0 |
| kube-system/svclb-traefik-328e2cec-k5bz6 | 0 / 0 | 2 / 2 |
| kube-system/svclb-traefik-328e2cec-zmxq7 | 0 / 0 | 0 / 0 |
| kube-system/traefik-9bcdbbd9-j6bg2 | 1 / 2 | 27 / 28 |
| larper/api-56c8f857c-p4m4n | 8 / 9 | 43 / 44 |
| larper/ingest-worker-7974b945dd-8s7qt | 1 / 1 | 138 / 144 |
| larper/outbox-relay-8fb96c489-lcq28 | 5 / 7 | 6 / 6 |
| larper/pg-1 | 17 / 40 | 342 / 343 |
| larper/redis-5bdc64d65d-lmhgf | 7 / 9 | 5 / 5 |
| larper/redpanda-0 | 6 / 8 | 103 / 103 |
| larper/taste-worker-f498bdf66-2pjks | 1 / 1 | 5 / 6 |
| monitoring/monitoring-grafana-79bd66db5-mcnnv | 20 / 31 | 369 / 371 |
| monitoring/monitoring-kube-prometheus-operator-6b848dc9df-vfm4j | 5 / 7 | 21 / 23 |
| monitoring/monitoring-kube-state-metrics-589d94698-lp56f | 2 / 4 | 21 / 22 |
| monitoring/prometheus-monitoring-kube-prometheus-prometheus-0 | 16 / 31 | 396 / 399 |
