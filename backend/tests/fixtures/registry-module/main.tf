terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "name" {
  type        = string
  description = "Network name"
  nullable    = false
}

variable "cidrs" {
  type        = list(string)
  description = "Network CIDRs"
  default     = ["10.0.0.0/24"]
  sensitive   = true
}

resource "aws_vpc" "main" {
  cidr_block = var.cidrs[0]
  tags = { Name = var.name }
}

data "aws_region" "current" {}

module "labels" {
  source  = "cloudposse/label/null"
  version = "0.25.0"
}

output "vpc_id" {
  description = "Created VPC ID"
  value       = aws_vpc.main.id
  sensitive   = true
}
