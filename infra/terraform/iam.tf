# Three purpose-built service accounts. Never the default compute SA: it is Editor on the
# whole project and shared with anything else running in it.
resource "google_service_account" "stage" {
  account_id   = "${var.name_prefix}-stage"
  project      = var.project_id
  display_name = "Devcon POC stage hosts"

  depends_on = [google_project_service.required]
}

resource "google_service_account" "monitoring" {
  account_id   = "${var.name_prefix}-monitoring"
  project      = var.project_id
  display_name = "Devcon POC monitoring host"

  depends_on = [google_project_service.required]
}

resource "google_service_account" "deployer" {
  account_id   = "${var.name_prefix}-deployer"
  project      = var.project_id
  display_name = "Devcon POC deployer (IAP tunnel, config push)"
  description  = "Inert until a principal is granted impersonation via deployer_principals."

  depends_on = [google_project_service.required]
}

# google_project_iam_member only: _binding and _policy are authoritative and would strip
# members this configuration does not know about from a project it does not own.

# Hosts write logs and metrics and nothing else. Secret reads are a human step
# (`gcloud secrets versions access`), so no accessor role is attached to a host.
resource "google_project_iam_member" "stage_host" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.stage.email}"
}

resource "google_project_iam_member" "monitoring_host" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.monitoring.email}"
}

# The deployer reaches hosts over IAP and needs to see instances to name a tunnel target.
# Project-wide, those two roles reach every sibling tenant's instances — a tunnel to any port,
# and read access to any instance's metadata. The conditions below confine them to our hosts,
# and the port 22 clause keeps the manager-UI rule inert even if its bind ever widens. Two
# resources rather than one for_each because the condition differs per role. `extract()` reads
# both resource-name formats in play: the compute one
# (`projects/ID/zones/.../instances/NAME`) and the IAP tunnel one
# (`projects/NUMBER/iap_tunnel/zones/.../instances/NAME`). A conditioned viewer grant cannot
# list, which costs nothing: the rendered ssh_config names every instance explicitly, so
# nothing here needs to discover one.
resource "google_project_iam_member" "deployer_tunnel" {
  project = var.project_id
  role    = "roles/iap.tunnelResourceAccessor"
  member  = "serviceAccount:${google_service_account.deployer.email}"

  condition {
    title      = "devcon-instances-ssh-only"
    expression = "resource.name.extract(\"/instances/{name}\").startsWith(\"${var.name_prefix}-\") && destination.port == 22"
  }
}

resource "google_project_iam_member" "deployer_viewer" {
  project = var.project_id
  role    = "roles/compute.viewer"
  member  = "serviceAccount:${google_service_account.deployer.email}"

  condition {
    title      = "devcon-instances-only"
    expression = "resource.name.extract(\"/instances/{name}\").startsWith(\"${var.name_prefix}-\")"
  }
}

resource "google_service_account_iam_member" "deployer_impersonation" {
  for_each = toset(var.deployer_principals)

  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = each.value
}
