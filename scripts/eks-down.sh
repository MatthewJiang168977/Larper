#!/usr/bin/env bash
# Tear EKS down to $0 and prove it.
#   scripts/eks-down.sh         # asks before terraform destroy
#   scripts/eks-down.sh --yes   # no prompt
#
# Order matters. Kubernetes creates AWS resources Terraform doesn't know about: the
# NLB for Traefik's LoadBalancer Service and an EBS volume per PersistentVolume. A
# plain `terraform destroy` would leave them behind (still billing) and fail on the
# VPC they sit in. So: uninstall what created them, wait until AWS has deleted them,
# then destroy, then check that nothing tagged for this cluster is left.
set -euo pipefail
cd "$(dirname "$0")/.."

TF=infra/terraform/eks
AUTO=""; [[ "${1:-}" == "--yes" ]] && AUTO="-auto-approve"
REGION=$(terraform -chdir=$TF output -raw region 2>/dev/null || echo us-east-1)
CLUSTER=$(terraform -chdir=$TF output -raw cluster_name 2>/dev/null || echo larper)
VPC=$(terraform -chdir=$TF output -raw vpc_id 2>/dev/null || echo "")
export AWS_REGION=$REGION

wait_for() { # description, timeout seconds, command that succeeds when done
  local what=$1 limit=$2; shift 2
  local start=$SECONDS
  until "$@"; do
    if (( SECONDS - start > limit )); then echo "timed out waiting for $what" >&2; return 1; fi
    sleep 10
  done
}

if aws eks describe-cluster --name "$CLUSTER" >/dev/null 2>&1; then
  echo "==> uninstalling releases on $CLUSTER"
  aws eks update-kubeconfig --name "$CLUSTER" --alias larper-eks >/dev/null
  kubectl config use-context larper-eks >/dev/null

  helm uninstall larper -n larper --wait 2>/dev/null || true
  # StatefulSet PVCs (Redpanda) survive an uninstall; CNPG's go with its Cluster.
  kubectl delete pvc --all --all-namespaces --wait=false 2>/dev/null || true
  helm uninstall traefik -n traefik --wait 2>/dev/null || true
  helm uninstall monitoring -n monitoring --wait 2>/dev/null || true
  helm uninstall cnpg -n cnpg-system --wait 2>/dev/null || true
  helm uninstall metrics-server -n kube-system --wait 2>/dev/null || true
  # Anything else that could own an AWS resource.
  kubectl get svc -A -o jsonpath='{range .items[?(@.spec.type=="LoadBalancer")]}{.metadata.namespace} {.metadata.name}{"\n"}{end}' |
    while read -r ns name; do [[ -n "$ns" ]] && kubectl -n "$ns" delete svc "$name"; done

  echo "==> waiting for EBS volumes (PersistentVolumes) to be deleted"
  no_pvs() { [[ -z "$(kubectl get pv -o name 2>/dev/null)" ]]; }
  wait_for "PersistentVolumes" 600 no_pvs

  if [[ -n "$VPC" ]]; then
    echo "==> waiting for load balancers in $VPC to be deleted"
    no_lbs() {
      [[ -z "$( { aws elbv2 describe-load-balancers --query "LoadBalancers[?VpcId=='$VPC'].LoadBalancerArn" --output text
                  aws elb describe-load-balancers --query "LoadBalancerDescriptions[?VPCId=='$VPC'].LoadBalancerName" --output text
                } | tr -d '[:space:]')" ]]
    }
    wait_for "load balancers" 600 no_lbs
    # Security groups the in-tree load balancer code may have created (k8s-elb-*).
    for sg in $(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC" "Name=group-name,Values=k8s-*" \
                  --query 'SecurityGroups[].GroupId' --output text); do
      aws ec2 delete-security-group --group-id "$sg" || true
    done
  fi
fi

echo "==> terraform destroy"
terraform -chdir=$TF destroy $AUTO

echo "==> verifying nothing billable is left"
left=0
check() { # description, command printing leftovers
  local out; out=$("${@:2}" 2>/dev/null | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')
  if [[ -n "$out" && "$out" != "None" ]]; then echo "  LEFT: $1: $out"; left=1; else echo "  ok:   $1"; fi
}
check "EKS cluster" aws eks list-clusters --query "clusters[?@=='$CLUSTER']" --output text
check "EC2 instances" aws ec2 describe-instances \
  --filters "Name=tag:eks:cluster-name,Values=$CLUSTER" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text
check "EBS volumes (CSI)" aws ec2 describe-volumes --filters "Name=tag:kubernetes.io/cluster/$CLUSTER,Values=owned" \
  --query 'Volumes[].VolumeId' --output text
check "EBS volumes (project tag)" aws ec2 describe-volumes --filters "Name=tag:project,Values=larper" \
  --query 'Volumes[].VolumeId' --output text
check "Elastic IPs" aws ec2 describe-addresses --filters "Name=tag:project,Values=larper" \
  --query 'Addresses[].PublicIp' --output text
check "VPC" aws ec2 describe-vpcs --filters "Name=tag:project,Values=larper" --query 'Vpcs[].VpcId' --output text
if [[ -n "$VPC" ]]; then
  check "load balancers (v2)" aws elbv2 describe-load-balancers --query "LoadBalancers[?VpcId=='$VPC'].LoadBalancerName" --output text
  check "load balancers (classic)" aws elb describe-load-balancers --query "LoadBalancerDescriptions[?VPCId=='$VPC'].LoadBalancerName" --output text
fi
check "ECR repositories" aws ecr describe-repositories --query "repositories[?starts_with(repositoryName,'larper-')].repositoryName" --output text

if (( left )); then echo "Something is still there (see LEFT above). It may still bill." >&2; exit 1; fi
echo "All clear: nothing from the EKS stack remains. (The SQS queues in infra/terraform/aws stay; they're free.)"
