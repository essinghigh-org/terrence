variable "public_label" {
  type = string
  default = "visible-fixture-value"
}
variable "credential" {
  type = string
  sensitive = true
  default = "engine-fixture-secret"
}
output "public_label" {
  value = var.public_label
}
output "credential" {
  value = var.credential
  sensitive = true
}
