# Not valid: do not use these numbers

This run happened while Grafana was crash-looping (OOM-killed at its 256Mi limit,
14 restarts from 20:42 local). With no CPU limit, each restart burned ~9 cores on
k3d-larper-server-0, the node running Postgres and one API pod, so API CPU and
latency here are skewed. Fixed in infra/monitoring/values.yaml; the run was repeated:
hpa-sizing-20261013-211748
