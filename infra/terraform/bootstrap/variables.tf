variable "project_id" {
  description = "Existing GCP project that holds the state bucket."
  type        = string
}

variable "state_bucket_name" {
  description = "Globally unique name for the Terraform state bucket."
  type        = string
}
