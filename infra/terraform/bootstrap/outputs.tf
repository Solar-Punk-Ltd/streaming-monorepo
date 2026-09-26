output "state_bucket_name" {
  description = "Name of the state bucket the parent root initialises against."
  value       = google_storage_bucket.state.name
}

output "backend_config" {
  description = "Paste into ../envs/poc.backend.hcl."
  value       = <<-EOT
    bucket = "${google_storage_bucket.state.name}"
    prefix = "poc"
  EOT
}
