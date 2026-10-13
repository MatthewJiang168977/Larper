# Subscription-wide cost alert. Separate state from ../ on purpose: the cluster is
# destroyed between demos, the alert should outlive it. Apply once:
#
#   terraform init
#   terraform apply -var subscription_id=... -var alert_email=you@example.com
#
# Budgets only alert; Azure doesn't stop spending when one is crossed.

terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
  }
}

provider "azurerm" {
  subscription_id = var.subscription_id
  features {}
}

variable "subscription_id" {
  type = string
}

variable "alert_email" {
  type = string
}

variable "amount" {
  description = "Monthly budget in the subscription's billing currency."
  type        = number
  default     = 20
}

resource "azurerm_consumption_budget_subscription" "larper" {
  name            = "larper-monthly"
  subscription_id = "/subscriptions/${var.subscription_id}"
  amount          = var.amount
  time_grain      = "Monthly"

  time_period {
    # Budgets must start on the first of a month; pinned at creation.
    start_date = formatdate("YYYY-MM-01'T'00:00:00Z", timestamp())
  }

  # Early warnings while spend is still small, then the forecast so a cluster left
  # running gets flagged before the month's money is gone.
  notification {
    threshold      = 50
    threshold_type = "Actual"
    operator       = "GreaterThanOrEqualTo"
    contact_emails = [var.alert_email]
  }
  notification {
    threshold      = 100
    threshold_type = "Actual"
    operator       = "GreaterThanOrEqualTo"
    contact_emails = [var.alert_email]
  }
  notification {
    threshold      = 100
    threshold_type = "Forecasted"
    operator       = "GreaterThanOrEqualTo"
    contact_emails = [var.alert_email]
  }

  lifecycle {
    ignore_changes = [time_period]
  }
}
