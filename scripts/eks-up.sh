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

# Node scale-out: Karpenter (credentials via Pod Identity, see karpenter.tf) and a
# NodePool capped at one extra t4g.large. It runs on the managed node, never on a
# node it launched (the chart's default affinity).
CLUSTER=$(terraform -chdir=$TF output -raw cluster_name)
helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter --version 1.15.0 \
  -n kube-system --wait \
  --set settings.clusterName="$CLUSTER" \
  --set replicas=1 \
  --set controller.resources.requests.cpu=100m --set controller.resources.requests.memory=256Mi \
  --set controller.resources.limits.memory=256Mi
terraform -chdir=$TF output -json karpenter | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const k = JSON.parse(s);
  console.log(`apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata: { name: default }
spec:
  role: ${k.node_role}
  amiSelectorTerms: [{ alias: al2023@latest }]
  subnetSelectorTerms: [${k.subnet_ids.map((id) => `{ id: ${id} }`).join(", ")}]
  securityGroupSelectorTerms: [{ id: ${k.security_group_id} }]
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs: { volumeSize: 20Gi, volumeType: gp3, deleteOnTermination: true }
  tags: { project: larper }
---
apiVersion: karpenter.sh/v1
kind: NodePool
metadata: { name: default }
spec:
  template:
    spec:
      nodeClassRef: { group: karpenter.k8s.aws, kind: EC2NodeClass, name: default }
      requirements:
        - { key: node.kubernetes.io/instance-type, operator: In, values: [${k.instance_type}] }
        - { key: karpenter.sh/capacity-type, operator: In, values: [on-demand] }
        - { key: kubernetes.io/arch, operator: In, values: [${k.arch}] }
  # A t4g.large has exactly 2 vCPU, so a 2-CPU limit allows one extra node, never two.
  limits: { cpu: "${k.max_extra_cpu}" }
  disruption:
    # Only remove nodes that are empty (no pods moved off busy nodes mid-demo), and
    # quickly: 30 s after the last app pod leaves, the node is terminated.
    consolidationPolicy: WhenEmpty
    consolidateAfter: 30s`);
});' | kubectl apply -f -
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

# A t4g.large takes 35 pods (ENI/IP limit, no prefix delegation). The stack needs
# about 30 on one node at peak; warn before it gets tight.
echo "==> pods per node (non-terminated / capacity)"
kubectl get pods -A --field-selector=status.phase!=Succeeded,status.phase!=Failed \
  -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' | sort | uniq -c |
  while read -r n node; do
    cap=$(kubectl get node "$node" -o jsonpath='{.status.allocatable.pods}')
    flag=""; (( n > cap - 4 )) && flag="  <-- within 3 of the limit"
    echo "  $node: $n / $cap$flag"
  done

HOST=$(kubectl -n traefik get svc traefik -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
echo "Up at http://$HOST  (DNS can take a minute or two: curl http://$HOST/healthz)"
echo "Load data: README 'Load place data', same commands against this context."
echo "Load test: BASE_URL=http://$HOST CLERK_SECRET_KEY=... k6 run loadtest/quests.js"
echo "Tear down: scripts/eks-down.sh"
