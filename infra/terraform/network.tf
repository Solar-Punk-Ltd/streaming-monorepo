# Never the default network: it ships permissive pre-populated firewall rules and an
# auto-created subnet in every region.
resource "google_compute_network" "vpc" {
  name                    = "${var.name_prefix}-vpc"
  project                 = var.project_id
  auto_create_subnetworks = false
  routing_mode            = "GLOBAL"

  depends_on = [google_project_service.required]
}

# A stage added in a region with no CIDR entry is a .tfvars mistake, caught by the subnet_cidrs
# validation in variables.tf: variable validation fires before the graph is walked, and once
# rather than per subnet.
resource "google_compute_subnetwork" "subnet" {
  for_each = local.subnet_regions

  name                     = "${var.name_prefix}-${each.key}"
  project                  = var.project_id
  region                   = each.key
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = local.subnet_cidr_by_region[each.key]
  private_ip_google_access = true
}
