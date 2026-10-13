#!/usr/bin/env bash
# Deploy the stack to AKS after `terraform apply` in infra/terraform/azure and
# infra/terraform/aws. Builds and pushes images tagged with the git commit, then
# installs CNPG, Traefik, monitoring and the larper chart. Safe to re-run.
# Teardown is `terraform destroy` (see infra/terraform/azure/main.tf), not a script.
set -euo pipefail
cd "$(dirname "$0")/.."

ACR=$(terraform -chdir=infra/terraform/azure output -raw acr_login_server)
TAG=$(git rev-parse --short HEAD)$(git diff --quiet HEAD || echo -dirty)
eval "$(terraform -chdir=infra/terraform/azure output -raw get_credentials)" --overwrite-existing
az acr login --name "${ACR%%.*}"

REGISTRY=$ACR TAG=$TAG scripts/build-images.sh

helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null 2>&1 || true
helm repo add traefik https://traefik.github.io/charts >/dev/null 2>&1 || true
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update cnpg traefik prometheus-community >/dev/null
helm upgrade --install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace --wait
helm upgrade --install traefik traefik/traefik -n traefik --create-namespace --wait

kubectl create namespace larper --dry-run=client -o yaml | kubectl apply -f -
kubectl -n larper create secret generic aws-sqs \
  --from-literal=access_key_id="$(terraform -chdir=infra/terraform/aws output -raw access_key_id)" \
  --from-literal=secret_access_key="$(terraform -chdir=infra/terraform/aws output -raw secret_access_key)" \
  --dry-run=client -o yaml | kubectl apply -f -

# Monitoring first: the chart's ServiceMonitor needs its CRDs.
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --version 92.2.0 -n monitoring --create-namespace \
  -f infra/monitoring/values.yaml --wait --timeout 10m

helm upgrade --install larper infra/helm/larper -n larper -f infra/helm/larper/values-aks.yaml \
  --set postgres.image="$ACR/larper-postgres:$TAG" \
  --set migrate.image="$ACR/larper-migrate:$TAG" \
  --set workers.image="$ACR/larper-workers:$TAG" \
  --set ingest.image="$ACR/larper-ingest:$TAG" \
  --set api.image="$ACR/larper-api:$TAG" \
  --wait --timeout 10m

IP=$(kubectl -n traefik get svc traefik -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "Up at http://$IP  (curl http://$IP/healthz)"
echo "Load data: README 'Load place data', same commands against this context."
echo "Load test: BASE_URL=http://$IP CLERK_SECRET_KEY=... k6 run loadtest/quests.js"
