terraform {
  required_providers {
    oci = { source = "oracle/oci" }
  }
}

# When run from OCI Resource Manager, authentication is handled by the service.
provider "oci" {
  region = var.region
}

variable "tenancy_ocid" {
  type        = string
  description = "Tenancy OCID (also the root compartment OCID)"
}

variable "compartment_ocid" {
  type        = string
  description = "Compartment OCID — use the root compartment (same as tenancy OCID)"
}

variable "ssh_public_key" {
  type        = string
  description = "SSH public key for the ubuntu user"
}

variable "shape" {
  type        = string
  default     = "VM.Standard.A1.Flex"
  description = "Compute shape. VM.Standard.A1.Flex (free, 4 OCPU/24GB) or VM.Standard.E2.1.Micro (free, 1 OCPU/1GB)"
}

variable "region" {
  type    = string
  default = "us-sanjose-1"
}

# Reuse the networking already built in the console:
# VCN "bot-vcn" with public subnet "bot-public-subnet" and a port-3001 ingress rule.
data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

data "oci_core_vcns" "bot" {
  compartment_id = var.compartment_ocid
  display_name   = "bot-vcn"
}

data "oci_core_subnets" "public" {
  compartment_id = var.compartment_ocid
  vcn_id         = data.oci_core_vcns.bot.virtual_networks[0].id
  display_name   = "bot-public-subnet"
}

data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_instance" "wa_trade_bot" {
  compartment_id      = var.compartment_ocid
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
  display_name        = "wa-trade-bot"
  shape               = var.shape

  dynamic "shape_config" {
    for_each = var.shape == "VM.Standard.A1.Flex" ? [1] : []
    content {
      ocpus         = 4
      memory_in_gbs = 24
    }
  }

  source_details {
    source_type = "image"
    source_id   = data.oci_core_images.ubuntu.images[0].id
  }

  create_vnic_details {
    subnet_id        = data.oci_core_subnets.public.subnets[0].id
    assign_public_ip = true
    display_name     = "wa-trade-bot-vnic"
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
  }
}

output "public_ip" {
  value       = oci_core_instance.wa_trade_bot.public_ip
  description = "Public IPv4 of the bot instance — the setup UI lives at http://<ip>:3001"
}
