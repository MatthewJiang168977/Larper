# EKS on demand: create for a demo, destroy right after (scripts/eks-down.sh).
#
#   terraform init
#   terraform plan -out=tfplan && terraform apply tfplan
#   ../../../scripts/eks-up.sh        # images, add-ons, the larper chart
#   ../../../scripts/eks-down.sh      # uninstall, destroy, verify nothing is left
#
# Cost shape (us-east-1): the control plane is $0.10/h whatever runs on it; one
# t4g.large node; no NAT gateway (nodes sit in public subnets, so they reach ECR,
# S3 and SQS through the internet gateway for free). See README "Cloud costs".
#
# The deploying IAM user needs deployer-policy.json attached (fill in the account):
#   sed "s/ACCOUNT_ID/$(aws sts get-caller-identity --query Account --output text)/" deployer-policy.json
#
# Needs ../aws applied first: the SQS queues live there, because they outlive this
# cluster (and serve the AKS/OKE targets through a static key).

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = { project = "larper" } }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "cluster_name" {
  type    = string
  default = "larper"
}

variable "kubernetes_version" {
  # Standard support until 2027-12-01. Never pick a version in extended support:
  # it bills $0.60/h instead of $0.10/h.
  type    = string
  default = "1.37"
}

variable "instance_type" {
  # Graviton (arm64), 2 vCPU / 8 GiB: the cheapest 8 GiB instance, and the stack
  # needs 8 GiB (Redpanda + Postgres + Prometheus + an ingest job). The images are
  # multi-arch, so t3.large (x86) works too, for about $0.016/h more.
  type    = string
  default = "t4g.large"
}

variable "capacity_type" {
  # SPOT is about 70% cheaper but AWS can reclaim the node with 2 minutes' notice.
  type    = string
  default = "ON_DEMAND"
}

locals {
  arm = can(regex("^[a-z]+[0-9]+g", var.instance_type)) # t4g, m7g, c8g...: Graviton
}

# ---------------------------------------------------------------------------
# Network: a VPC with two public subnets (EKS requires two AZs) and no NAT gateway,
# which would cost $0.045/h plus data processing. Nodes get public IPs, and their
# security group (managed by EKS) admits nothing from the internet.

data "aws_ec2_instance_type_offerings" "node" {
  location_type = "availability-zone"
  filter {
    name   = "instance-type"
    values = [var.instance_type]
  }
}

locals {
  # Only AZs that actually offer the node type (not every us-east-1 AZ has Graviton).
  azs = slice(sort(data.aws_ec2_instance_type_offerings.node.locations), 0, 2)
}

resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "larper" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 4, count.index)
  map_public_ip_on_launch = true
  tags = {
    Name = "larper-public-${count.index}"
    # Where Kubernetes may place internet-facing load balancers (Traefik's NLB).
    "kubernetes.io/role/elb"                    = "1"
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ---------------------------------------------------------------------------
# Cluster

resource "aws_iam_role" "cluster" {
  name = "${var.cluster_name}-eks-cluster"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
    }]
  })
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_eks_cluster" "main" {
  name     = var.cluster_name
  version  = var.kubernetes_version
  role_arn = aws_iam_role.cluster.arn

  vpc_config {
    subnet_ids              = aws_subnet.public[*].id
    endpoint_public_access  = true
    endpoint_private_access = true
  }

  access_config {
    # Access entries, not the aws-auth ConfigMap. Whoever applies this is admin.
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = true
  }

  # STANDARD: at end of standard support the cluster is upgraded instead of moving
  # to extended support (6x the control-plane price).
  upgrade_policy {
    support_type = "STANDARD"
  }

  # No control-plane logging: CloudWatch ingestion is billed per GB.

  depends_on = [aws_iam_role_policy_attachment.cluster]
}

# ---------------------------------------------------------------------------
# Nodes: one managed node.

resource "aws_iam_role" "node" {
  name = "${var.cluster_name}-eks-node"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly", # pull from ECR
  ])
  role       = aws_iam_role.node.name
  policy_arn = each.value
}

resource "aws_eks_node_group" "main" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "main"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = aws_subnet.public[*].id
  ami_type        = local.arm ? "AL2023_ARM_64_STANDARD" : "AL2023_x86_64_STANDARD"
  instance_types  = [var.instance_type]
  capacity_type   = var.capacity_type
  disk_size       = 20 # GiB gp3 root volume; images + logs fit easily

  scaling_config {
    desired_size = 1
    min_size     = 1
    max_size     = 1
  }

  update_config {
    max_unavailable = 1
  }

  depends_on = [aws_iam_role_policy_attachment.node]
}

# ---------------------------------------------------------------------------
# Add-ons. vpc-cni, kube-proxy and CoreDNS come with the cluster. Pod Identity lets
# pods assume IAM roles without static keys; the EBS CSI driver provisions the
# PersistentVolumes (Postgres, Redpanda) and uses Pod Identity itself.

resource "aws_eks_addon" "pod_identity" {
  cluster_name = aws_eks_cluster.main.name
  addon_name   = "eks-pod-identity-agent"
}

data "aws_iam_policy_document" "pods_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ebs_csi" {
  name               = "${var.cluster_name}-ebs-csi"
  assume_role_policy = data.aws_iam_policy_document.pods_assume.json
}

resource "aws_iam_role_policy_attachment" "ebs_csi" {
  role       = aws_iam_role.ebs_csi.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}

resource "aws_eks_addon" "ebs_csi" {
  cluster_name = aws_eks_cluster.main.name
  addon_name   = "aws-ebs-csi-driver"
  pod_identity_association {
    role_arn        = aws_iam_role.ebs_csi.arn
    service_account = "ebs-csi-controller-sa"
  }
  depends_on = [aws_eks_addon.pod_identity, aws_eks_node_group.main]
}

# ---------------------------------------------------------------------------
# SQS access for the ingest-worker: a role its ServiceAccount assumes through Pod
# Identity. Same actions and queues as the static-key user in ../aws, but the
# credentials are short-lived and never leave AWS.

data "aws_sqs_queue" "ingest" {
  name = "larper-ingest-area"
}

data "aws_sqs_queue" "ingest_dlq" {
  name = "larper-ingest-area-dlq"
}

resource "aws_iam_role" "ingest_worker" {
  name               = "${var.cluster_name}-ingest-worker"
  assume_role_policy = data.aws_iam_policy_document.pods_assume.json
}

resource "aws_iam_role_policy" "ingest_worker_sqs" {
  name = "larper-sqs"
  role = aws_iam_role.ingest_worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "sqs:GetQueueUrl",
        "sqs:SendMessage",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:ChangeMessageVisibility",
      ]
      Resource = [data.aws_sqs_queue.ingest.arn, data.aws_sqs_queue.ingest_dlq.arn]
    }]
  })
}

resource "aws_eks_pod_identity_association" "ingest_worker" {
  cluster_name    = aws_eks_cluster.main.name
  namespace       = "larper"
  service_account = "ingest-worker"
  role_arn        = aws_iam_role.ingest_worker.arn
}

# ---------------------------------------------------------------------------
# Image registry. Destroyed with the cluster (force_delete drops the images too);
# eks-up.sh pushes them again next time.

resource "aws_ecr_repository" "images" {
  for_each             = toset(["larper-api", "larper-migrate", "larper-workers", "larper-ingest", "larper-postgres"])
  name                 = each.key
  force_delete         = true
  image_tag_mutability = "MUTABLE" # -dirty tags get rebuilt in place
}

resource "aws_ecr_lifecycle_policy" "images" {
  for_each   = aws_ecr_repository.images
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep the last 5 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

# ---------------------------------------------------------------------------

output "cluster_name" {
  value = aws_eks_cluster.main.name
}

output "registry" {
  value = split("/", aws_ecr_repository.images["larper-api"].repository_url)[0]
}

output "update_kubeconfig" {
  value = "aws eks update-kubeconfig --region ${var.region} --name ${aws_eks_cluster.main.name} --alias larper-eks"
}

output "region" {
  value = var.region
}

output "vpc_id" {
  value = aws_vpc.main.id
}
