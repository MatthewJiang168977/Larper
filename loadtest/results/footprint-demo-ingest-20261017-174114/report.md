# Footprint: demo-ingest

27 samples of every pod (kubectl top), 27 of the k3d node containers (docker stats).

| Namespace | CPU mean / peak (m) | Memory mean / peak (Mi) |
|---|---|---|
| cnpg-system | 8 / 10 | 31 / 33 |
| kube-system | 21 / 29 | 82 / 83 |
| larper | 176 / 372 | 676 / 764 |
| monitoring | 59 / 72 | 801 / 808 |
| **all pods except monitoring** | **205 / 410** | **789 / 876** |
| all pods | 264 / 482 | 1590 / 1673 |

k3d node containers (pods + k3s + containerd, 3 nodes): 3347 Mi mean, 3431 Mi peak.

| Pod | CPU mean / peak (m) | Memory mean / peak (Mi) |
|---|---|---|
| cnpg-system/cnpg-cloudnative-pg-84cd4568f9-rw86h | 8 / 10 | 31 / 33 |
| kube-system/coredns-8db54c48d-zn76j | 6 / 12 | 20 / 21 |
| kube-system/local-path-provisioner-5d9d9885bc-5sv7j | 1 / 1 | 8 / 8 |
| kube-system/metrics-server-786d997795-jpbq4 | 11 / 15 | 25 / 25 |
| kube-system/svclb-traefik-328e2cec-448gc | 0 / 0 | 0 / 0 |
| kube-system/svclb-traefik-328e2cec-k5bz6 | 0 / 0 | 2 / 2 |
| kube-system/svclb-traefik-328e2cec-zmxq7 | 0 / 0 | 0 / 0 |
| kube-system/traefik-9bcdbbd9-j6bg2 | 3 / 6 | 27 / 28 |
| larper/api-56c8f857c-7z7cb | 20 / 45 | 43 / 44 |
| larper/api-56c8f857c-p4m4n | 14 / 40 | 43 / 43 |
| larper/ingest-worker-7974b945dd-8s7qt | 68 / 269 | 169 / 248 |
| larper/outbox-relay-8fb96c489-lcq28 | 8 / 10 | 6 / 6 |
| larper/pg-1 | 55 / 170 | 314 / 325 |
| larper/redis-5bdc64d65d-lmhgf | 9 / 11 | 5 / 5 |
| larper/redpanda-0 | 7 / 10 | 102 / 103 |
| larper/taste-worker-f498bdf66-2pjks | 1 / 3 | 5 / 6 |
| monitoring/monitoring-grafana-79bd66db5-mcnnv | 26 / 35 | 369 / 369 |
| monitoring/monitoring-kube-prometheus-operator-6b848dc9df-vfm4j | 8 / 14 | 21 / 22 |
| monitoring/monitoring-kube-state-metrics-589d94698-lp56f | 3 / 4 | 21 / 22 |
| monitoring/prometheus-monitoring-kube-prometheus-prometheus-0 | 23 / 38 | 390 / 397 |
