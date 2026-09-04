# The project already exists and may predate this repo, so nothing here is ever disabled on
# destroy: another tenant of the project may be relying on the same API.
resource "google_project_service" "required" {
  for_each = var.manage_project_services ? toset([
    "compute.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "iap.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
  ]) : toset([])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
