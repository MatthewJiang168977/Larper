#!/usr/bin/env bash
# Install Prometheus + Grafana (kube-prometheus-stack) into the current kube context,
# then turn on the larper chart's ServiceMonitor and dashboard. Safe to re-run.
#   scripts/monitoring.sh                      # k3d
#   VALUES=values-aks.yaml scripts/monitoring.sh  # AKS
set -euo pipefail
cd "$(dirname "$0")/.."

helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update prometheus-community >/dev/null
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --version 92.2.0 -n monitoring --create-namespace \
  -f infra/monitoring/values.yaml --wait --timeout 10m

extra=()
[[ -n "${VALUES:-}" ]] && extra=(-f "infra/helm/larper/${VALUES}")
helm upgrade larper infra/helm/larper -n larper --reset-then-reuse-values "${extra[@]}" --set monitoring.enabled=true

pw=$(kubectl -n monitoring get secret monitoring-grafana -o jsonpath='{.data.admin-password}' | base64 -d)
echo "Grafana: kubectl -n monitoring port-forward svc/monitoring-grafana 3002:80"
echo "         http://localhost:3002  (admin / ${pw})  -> Dashboards -> Larper API"
