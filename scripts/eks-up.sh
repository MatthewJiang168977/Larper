#!/usr/bin/env bash
# Deploy the stack to EKS after `terraform apply` in infra/terraform/eks. Pushes
# multi-arch images to ECR, installs cluster add-ons and the larper chart. Safe to
# re-run. Tear down with scripts/eks-down.sh (never plain terraform destroy: it
# would orphan the load balancer and volumes Kubernetes created).
set -euo pipefail
cd "$(dirname "$0")/.."

TF=infra/terraform/eks
REGION=$(terraform -chdir=$TF output -raw region)
REGISTRY=$(terraform -chdir=$TF output -raw registry)
TAG=$(git rev-parse --short HEAD)$(git diff --quiet HEAD || echo -dirty)

eval "$(terraform -chdir=$TF output -raw update_kubeconfig)"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
REGISTRY=$REGISTRY TAG=$TAG scripts/build-images.sh

# EKS ships a gp2 class that isn't the default; PVCs need a default. gp3 is cheaper
# and faster than gp2.
kubectl apply -f - <<'EOF'
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations: { storageclass.kubernetes.io/is-default-class: "true" }
provisioner: ebs.csi.aws.com
parameters: { type: gp3 }
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
EOF

helm repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null 2>&1 || true
helm repo add traefik https://traefik.github.io/charts >/dev/null 2>&1 || true
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/ >/dev/null 2>&1 || true
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update cnpg traefik metrics-server prometheus-community >/dev/null

# The HPA reads CPU from metrics-server, which EKS doesn't install.
helm upgrade --install metrics-server metrics-server/metrics-server -n kube-system --wait
helm upgrade --install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace --wait
# An NLB (not the legacy Classic LB) in the public subnets.
helm upgrade --install traefik traefik/traefik -n traefik --create-namespace --wait \
  --set 'service.annotations.service\.beta\.kubernetes\.io/aws-load-balancer-type=nlb'
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --version 92.2.0 -n monitoring --create-namespace \
  -f infra/monitoring/values.yaml --wait --timeout 10m

helm upgrade --install larper infra/helm/larper -n larper --create-namespace \
  -f infra/helm/larper/values-eks.yaml \
  --set queue.awsRegion="$REGION" \
  --set postgres.image="$REGISTRY/larper-postgres:$TAG" \
  --set migrate.image="$REGISTRY/larper-migrate:$TAG" \
  --set workers.image="$REGISTRY/larper-workers:$TAG" \
  --set ingest.image="$REGISTRY/larper-ingest:$TAG" \
  --set api.image="$REGISTRY/larper-api:$TAG" \
  --wait --timeout 15m

HOST=$(kubectl -n traefik get svc traefik -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
echo "Up at http://$HOST  (DNS can take a minute or two: curl http://$HOST/healthz)"
echo "Load data: README 'Load place data', same commands against this context."
echo "Load test: BASE_URL=http://$HOST CLERK_SECRET_KEY=... k6 run loadtest/quests.js"
echo "Tear down: scripts/eks-down.sh"
