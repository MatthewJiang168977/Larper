# The job queue for the cloud deploy: Amazon SQS, inside the always-free tier
# (1M requests/month). Everything else runs on Azure (../azure); only the
# ingest-worker talks to AWS, with a key that can touch these two queues and nothing else.
#
#   terraform init && terraform apply
#   terraform output -raw secret_access_key   # goes into the aws-sqs k8s Secret
#
# State is local and gitignored. It contains the secret key, so don't share it.

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

variable "max_attempts" {
  description = "Matches jobs.max_attempts. The worker dead-letters at this count itself."
  type        = number
  default     = 5
}

resource "aws_sqs_queue" "ingest_dlq" {
  name                      = "larper-ingest-area-dlq"
  message_retention_seconds = 1209600 # 14 days, the max: time to inspect poison messages
}

resource "aws_sqs_queue" "ingest" {
  name                       = "larper-ingest-area"
  visibility_timeout_seconds = 120    # default lease; the worker sets its own per receive
  receive_wait_time_seconds  = 20     # long polling by default
  message_retention_seconds  = 345600 # 4 days

  # Backstop only. The worker dead-letters a job on its (max_attempts+1)th delivery
  # and records why in the ledger; SQS moves anything that slips past that.
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ingest_dlq.arn
    maxReceiveCount     = var.max_attempts + 3
  })
}

# A machine user for the AKS pods. Azure workloads can't assume AWS roles without
# setting up OIDC federation, so this is a long-lived key with the smallest
# possible blast radius: these two queues, these actions.
resource "aws_iam_user" "worker" {
  name = "larper-ingest-worker"
}

resource "aws_iam_user_policy" "worker_sqs" {
  name = "larper-sqs"
  user = aws_iam_user.worker.name
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
      Resource = [aws_sqs_queue.ingest.arn, aws_sqs_queue.ingest_dlq.arn]
    }]
  })
}

resource "aws_iam_access_key" "worker" {
  user = aws_iam_user.worker.name
}

output "queue_url" {
  value = aws_sqs_queue.ingest.url
}

output "access_key_id" {
  value = aws_iam_access_key.worker.id
}

output "secret_access_key" {
  value     = aws_iam_access_key.worker.secret
  sensitive = true
}
