# Node scale-out with Karpenter. The managed node group stays at one node (it runs
# the system pods and Karpenter itself); when pods can't be scheduled, Karpenter
# launches up to two more t4g.large and removes each once it's empty. The idle
# stack (~2 CPU of requests) already needs one of them, so the second is the
# load-test headroom.
#
# Why Karpenter, not Cluster Autoscaler: Cluster Autoscaler publishes one image per
# Kubernetes minor and has none for 1.37 yet (newest v1.36.1). Karpenter 1.15
# supports 1.37.
#
# No interruption queue (SQS + EventBridge): that handling exists for Spot
# reclaims, and these nodes are on-demand.
#
# Karpenter creates AWS resources Terraform doesn't track: EC2 instances, launch
# templates and an instance profile. scripts/eks-down.sh deletes the NodePool and
# EC2NodeClass first and waits until Karpenter has cleaned those up.

variable "karpenter_max_extra_cpu" {
  # The NodePool's CPU limit: 4 = at most two extra 2-vCPU nodes.
  type    = number
  default = 4
}

resource "aws_iam_role" "karpenter" {
  name               = "${var.cluster_name}-karpenter"
  assume_role_policy = data.aws_iam_policy_document.pods_assume.json
}

data "aws_caller_identity" "current" {}

resource "aws_iam_role_policy" "karpenter" {
  name = "karpenter-controller"
  role = aws_iam_role.karpenter.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Discover"
        Effect = "Allow"
        Action = [
          "ec2:DescribeAvailabilityZones", "ec2:DescribeImages", "ec2:DescribeInstances",
          "ec2:DescribeInstanceTypeOfferings", "ec2:DescribeInstanceTypes",
          "ec2:DescribeLaunchTemplates", "ec2:DescribeSecurityGroups", "ec2:DescribeSpotPriceHistory",
          "ec2:DescribeSubnets", "pricing:GetProducts",
        ]
        Resource = "*"
      },
      {
        Sid      = "ResolveAmi"
        Effect   = "Allow"
        Action   = "ssm:GetParameter"
        Resource = "arn:aws:ssm:${var.region}::parameter/aws/service/*"
      },
      {
        Sid      = "Cluster"
        Effect   = "Allow"
        Action   = "eks:DescribeCluster"
        Resource = aws_eks_cluster.main.arn
      },
      {
        Sid    = "Launch"
        Effect = "Allow"
        Action = ["ec2:RunInstances", "ec2:CreateFleet", "ec2:CreateLaunchTemplate", "ec2:CreateTags"]
        Resource = [
          "arn:aws:ec2:${var.region}:*:instance/*", "arn:aws:ec2:${var.region}:*:fleet/*",
          "arn:aws:ec2:${var.region}:*:launch-template/*", "arn:aws:ec2:${var.region}:*:volume/*",
          "arn:aws:ec2:${var.region}:*:network-interface/*", "arn:aws:ec2:${var.region}:*:spot-instances-request/*",
          "arn:aws:ec2:${var.region}:*:subnet/*", "arn:aws:ec2:${var.region}:*:security-group/*",
          "arn:aws:ec2:${var.region}::image/*",
        ]
      },
      {
        # Only what Karpenter itself launched (it tags everything with its NodePool).
        Sid       = "TerminateOwn"
        Effect    = "Allow"
        Action    = ["ec2:TerminateInstances", "ec2:DeleteLaunchTemplate"]
        Resource  = "*"
        Condition = { StringLike = { "aws:ResourceTag/karpenter.sh/nodepool" = "*" } }
      },
      {
        Sid       = "PassNodeRole"
        Effect    = "Allow"
        Action    = "iam:PassRole"
        Resource  = aws_iam_role.node.arn
        Condition = { StringEquals = { "iam:PassedToService" = ["ec2.amazonaws.com"] } }
      },
      {
        # Karpenter makes (and on EC2NodeClass deletion, removes) the instance
        # profile that wraps the node role.
        Sid    = "InstanceProfile"
        Effect = "Allow"
        Action = [
          "iam:CreateInstanceProfile", "iam:TagInstanceProfile", "iam:AddRoleToInstanceProfile",
          "iam:RemoveRoleFromInstanceProfile", "iam:DeleteInstanceProfile", "iam:GetInstanceProfile",
          "iam:ListInstanceProfiles",
        ]
        Resource = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:instance-profile/*"
      },
    ]
  })
}

resource "aws_eks_pod_identity_association" "karpenter" {
  cluster_name    = aws_eks_cluster.main.name
  namespace       = "kube-system"
  service_account = "karpenter"
  role_arn        = aws_iam_role.karpenter.arn
}

# Karpenter's nodes reuse the managed node group's role, so the access entry EKS
# made for that group already lets them join.

output "karpenter" {
  # eks-up.sh renders the EC2NodeClass and NodePool from these.
  value = {
    node_role         = aws_iam_role.node.name
    subnet_ids        = aws_subnet.public[*].id
    security_group_id = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
    instance_type     = var.instance_type
    arch              = local.arm ? "arm64" : "amd64"
    max_extra_cpu     = var.karpenter_max_extra_cpu
  }
}
