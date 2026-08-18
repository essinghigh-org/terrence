variable "cidr" {
  type = string
}

resource "aws_subnet" "this" {
  cidr_block = var.cidr
  vpc_id     = "vpc-test"
}
