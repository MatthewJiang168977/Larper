# Footprint: full-idle

10 samples of every pod (kubectl top), 10 of the k3d node containers (docker stats).

| Namespace | CPU mean / peak (m) | Memory mean / peak (Mi) |
|---|---|---|
| cnpg-system | 8 / 12 | 28 / 29 |
| kube-system | 17 / 21 | 73 / 74 |
| larper | 60 / 78 | 322 / 323 |
| monitoring | 62 / 90 | 824 / 846 |
| **all pods except monitoring** | **85 / 108** | **423 / 424** |
| all pods | 146 / 179 | 1247 / 1269 |

k3d node containers (pods + k3s + containerd, 3 nodes): 2774 Mi mean, 2826 Mi peak.

| Pod | CPU mean / peak (m) | Memory mean / peak (Mi) |
|---|---|---|
| cnpg-system/cnpg-cloudnative-pg-84cd4568f9-rw86h | 8 / 12 | 28 / 29 |
| kube-system/coredns-8db54c48d-zn76j | 4 / 7 | 18 / 18 |
| kube-system/local-path-provisioner-5d9d9885bc-5sv7j | 1 / 2 | 8 / 8 |
| kube-system/metrics-server-786d997795-jpbq4 | 10 / 11 | 22 / 23 |
| kube-system/svclb-traefik-328e2cec-448gc | 0 / 0 | 0 / 0 |
| kube-system/svclb-traefik-328e2cec-k5bz6 | 0 / 0 | 2 / 2 |
| kube-system/svclb-traefik-328e2cec-zmxq7 | 0 / 0 | 0 / 0 |
| kube-system/traefik-9bcdbbd9-j6bg2 | 1 / 3 | 23 / 26 |
| larper/api-6745984596-92vf5 | 9 / 10 | 36 / 36 |
| larper/api-6745984596-p9gsn | 9 / 13 | 44 / 44 |
| larper/ingest-worker-656648c545-fbmj5 | 1 / 2 | 6 / 7 |
| larper/ingest-worker-656648c545-pfwdp | 1 / 2 | 6 / 6 |
| larper/outbox-relay-76456b6449-krrdr | 8 / 11 | 6 / 6 |
| larper/pg-1 | 15 / 22 | 76 / 77 |
| larper/redis-5bdc64d65d-lmhgf | 8 / 10 | 4 / 5 |
| larper/redpanda-0 | 7 / 8 | 136 / 137 |
| larper/taste-worker-588995cf6b-4tcnm | 1 / 2 | 4 / 4 |
| larper/taste-worker-588995cf6b-dls52 | 1 / 1 | 4 / 4 |
| monitoring/monitoring-grafana-79bd66db5-mcnnv | 27 / 39 | 375 / 375 |
| monitoring/monitoring-kube-prometheus-operator-6b848dc9df-vfm4j | 5 / 9 | 20 / 21 |
| monitoring/monitoring-kube-state-metrics-589d94698-lp56f | 3 / 4 | 19 / 20 |
| monitoring/prometheus-monitoring-kube-prometheus-prometheus-0 | 27 / 57 | 410 / 432 |
