# Footprint: demo-8vus

26 samples of every pod (kubectl top), 26 of the k3d node containers (docker stats).

| Namespace | CPU mean / peak (m) | Memory mean / peak (Mi) |
|---|---|---|
| cnpg-system | 6 / 8 | 29 / 30 |
| kube-system | 28 / 35 | 87 / 89 |
| larper | 227 / 291 | 725 / 751 |
| monitoring | 49 / 64 | 803 / 811 |
| **all pods except monitoring** | **261 / 328** | **841 / 867** |
| all pods | 310 / 392 | 1644 / 1673 |

k3d node containers (pods + k3s + containerd, 3 nodes): 3410 Mi mean, 3466 Mi peak.

| Pod | CPU mean / peak (m) | Memory mean / peak (Mi) |
|---|---|---|
| cnpg-system/cnpg-cloudnative-pg-84cd4568f9-rw86h | 6 / 8 | 29 / 30 |
| kube-system/coredns-8db54c48d-zn76j | 5 / 6 | 21 / 21 |
| kube-system/local-path-provisioner-5d9d9885bc-5sv7j | 1 / 1 | 8 / 8 |
| kube-system/metrics-server-786d997795-jpbq4 | 8 / 11 | 25 / 26 |
| kube-system/svclb-traefik-328e2cec-448gc | 0 / 0 | 0 / 0 |
| kube-system/svclb-traefik-328e2cec-k5bz6 | 0 / 0 | 2 / 2 |
| kube-system/svclb-traefik-328e2cec-zmxq7 | 0 / 0 | 0 / 0 |
| kube-system/traefik-9bcdbbd9-j6bg2 | 14 / 20 | 31 / 34 |
| larper/api-56c8f857c-p4m4n | 82 / 127 | 59 / 63 |
| larper/api-56c8f857c-r5p8h | 89 / 108 | 47 / 48 |
| larper/ingest-worker-7974b945dd-8s7qt | 1 / 2 | 131 / 132 |
| larper/outbox-relay-8fb96c489-lcq28 | 6 / 8 | 6 / 6 |
| larper/pg-1 | 51 / 69 | 376 / 419 |
| larper/redis-5bdc64d65d-lmhgf | 10 / 13 | 9 / 10 |
| larper/redpanda-0 | 7 / 9 | 102 / 103 |
| larper/taste-worker-f498bdf66-2pjks | 1 / 2 | 5 / 6 |
| monitoring/monitoring-grafana-79bd66db5-mcnnv | 22 / 31 | 368 / 369 |
| monitoring/monitoring-kube-prometheus-operator-6b848dc9df-vfm4j | 5 / 7 | 21 / 24 |
| monitoring/monitoring-kube-state-metrics-589d94698-lp56f | 2 / 4 | 21 / 23 |
| monitoring/prometheus-monitoring-kube-prometheus-prometheus-0 | 20 / 29 | 392 / 399 |
