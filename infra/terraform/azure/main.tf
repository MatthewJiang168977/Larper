# Azure side of the cloud deploy: one AKS cluster and a container registry, sized
# for the Azure for Students credit. Postgres, Redis, Redpanda and monitoring run
# as pods in the cluster (no managed-service fees); the job queue is SQS (../aws).
#
#   terraform init
#   terraform apply  -var subscription_id=$(az account show --query id -o tsv)
#   terraform destroy -var subscription_id=...    # between demos: this is the $0 state
#
# Destroy removes everything here, including the node resource group (MC_larper),
# which Azure deletes along with the cluster; it also holds the load balancer,
# public IPs and the disks behind PersistentVolumeClaims. The budget alert lives in
# ./budget with its own state, so destroying the cluster never removes it.
#
# Stopping instead (az aks stop) is NOT free: the OS disk, load balancer, public
# IPs and registry keep billing. See README "Cloud costs".

terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "azurerm" {
  subscription_id = var.subscription_id
  features {
    resource_group {
      # Kubernetes can create resources Terraform doesn't know about; destroy should
      # still remove the group rather than fail.
      prevent_deletion_if_contains_resources = false
    }
  }
}

variable "subscription_id" {
  type = string
}

variable "location" {
  description = "Student subscriptions restrict regions by policy; pick an allowed one."
  type        = string
  default     = "eastus"
}

variable "node_size" {
  # 2 vCPU / 8 GiB, AMD burstable. Cheaper than B2ms for the same memory. 4 GiB nodes
  # don't fit Redpanda + Postgres + Prometheus + an ingest job after AKS's own
  # reservations. Fallback if the Basv2 quota is 0: Standard_B2ms.
  type    = string
  default = "Standard_B2as_v2"
}

variable "node_count" {
  type    = number
  default = 1
}

locals {
  tags = { project = "larper" }
}

resource "azurerm_resource_group" "larper" {
  name     = "larper"
  location = var.location
  tags     = local.tags
}

resource "random_string" "acr" {
  length  = 6
  special = false
  upper   = false
}

# Basic: about $5/mo flat, 10 GB included. Our images total well under that.
resource "azurerm_container_registry" "acr" {
  name                = "larper${random_string.acr.result}"
  resource_group_name = azurerm_resource_group.larper.name
  location            = azurerm_resource_group.larper.location
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

resource "azurerm_kubernetes_cluster" "aks" {
  name                = "larper-aks"
  resource_group_name = azurerm_resource_group.larper.name
  location            = azurerm_resource_group.larper.location
  dns_prefix          = "larper"
  sku_tier            = "Free" # no control-plane charge, no uptime SLA
  node_resource_group = "MC_larper"
  tags                = local.tags

  default_node_pool {
    name       = "system"
    vm_size    = var.node_size
    node_count = var.node_count
    # The default is a 128 GB Premium disk (~$20/mo). 32 GB is a P4 (~$5/mo).
    os_disk_size_gb             = 32
    os_disk_type                = "Managed"
    max_pods                    = 60
    temporary_name_for_rotation = "rotate"
    upgrade_settings {
      max_surge = "10%"
    }
  }

  identity {
    type = "SystemAssigned"
  }

  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay" # pod IPs don't consume VNet addresses
    load_balancer_sku   = "standard"
    outbound_type       = "loadBalancer"
  }

  # No oms_agent / Container Insights: Log Analytics ingestion is billed per GB.
  # Monitoring is kube-prometheus-stack in the cluster instead.
}

# Lets the nodes pull from the registry without image pull secrets.
resource "azurerm_role_assignment" "aks_acr_pull" {
  principal_id                     = azurerm_kubernetes_cluster.aks.kubelet_identity[0].object_id
  role_definition_name             = "AcrPull"
  scope                            = azurerm_container_registry.acr.id
  skip_service_principal_aad_check = true
}

output "acr_login_server" {
  value = azurerm_container_registry.acr.login_server
}

output "get_credentials" {
  value = "az aks get-credentials -g ${azurerm_resource_group.larper.name} -n ${azurerm_kubernetes_cluster.aks.name}"
}
