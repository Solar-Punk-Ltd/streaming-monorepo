# Shared with the monitoring host in monitoring.tf.
data "google_compute_image" "ubuntu" {
  family  = "ubuntu-2404-lts-amd64"
  project = "ubuntu-os-cloud"

  # A data source is read during plan: on a fresh project this reads the Compute API before
  # enablement has had a chance to run, and the plan dies with SERVICE_DISABLED.
  depends_on = [google_project_service.required]
}

# The stage's external address doubles as its egress identity: GCP VM egress leaves through the
# instance's external address, so a Hetzner-side allowlist keys on exactly these.
resource "google_compute_address" "stage" {
  for_each = var.stages

  name         = "${local.stage_instance_names[each.key]}-ip"
  project      = var.project_id
  region       = each.value.region
  address_type = "EXTERNAL"

  # Nothing else in this resource reaches the Compute API, so the enablement is not implied.
  depends_on = [google_project_service.required]
}

# The internal address is reserved too: the Prometheus target, the inventory and the scrape
# rule's reasoning all carry it, and M4's destroy-and-rebuild must not orphan them. An
# unreserved internal IP changes on instance replacement.
resource "google_compute_address" "stage_internal" {
  for_each = var.stages

  name         = "${local.stage_instance_names[each.key]}-internal"
  project      = var.project_id
  region       = each.value.region
  subnetwork   = google_compute_subnetwork.subnet[each.value.region].id
  address_type = "INTERNAL"
  purpose      = "GCE_ENDPOINT"
}

resource "google_compute_instance" "stage" {
  for_each = var.stages

  name         = local.stage_instance_names[each.key]
  project      = var.project_id
  zone         = local.stage_zones[each.key]
  machine_type = each.value.machine

  # The per-stage tag carries the per-stage SRT rule; the shared tag carries everything that
  # applies to every stage host.
  tags = [local.stage_tag, "${local.stage_tag}-${each.key}"]

  # Machine sizing is an open question in the plan: a four-rung ladder is ~7 vCPU before the
  # per-host manager, Postgres and web UI. Resizing must not destroy the host.
  allow_stopping_for_update = true

  lifecycle {
    # The image data source floats to the newest 24.04 build, and a changed boot image forces
    # instance replacement. Without this, an apply weeks later replaces a running stage because
    # Ubuntu published an image. OS updates happen on the host; a rebuild picks up the new image.
    ignore_changes = [boot_disk[0].initialize_params[0].image]
  }

  labels = {
    role  = "stage"
    stage = each.key
  }

  boot_disk {
    initialize_params {
      image = data.google_compute_image.ubuntu.self_link
      size  = var.stage_boot_disk_gb
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.subnet[each.value.region].id
    network_ip = google_compute_address.stage_internal[each.key].address

    access_config {
      nat_ip = google_compute_address.stage[each.key].address
    }
  }

  service_account {
    email  = google_service_account.stage.email
    scopes = ["cloud-platform"]
  }

  # Of the three, only Secure Boot is off by API default. It is free here: docker.io and
  # node_exporter need nothing but Canonical-signed in-tree modules.
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    ssh-keys       = "${local.host_user}:${var.ssh_public_key}"
    enable-oslogin = "FALSE"

    # A tenant in a shared project: without this, project-level ssh-keys metadata — which
    # `gcloud compute ssh` appends to by default — grants sudo on this host to principals this
    # configuration never named.
    block-project-ssh-keys = "TRUE"

    startup-script = templatefile("${path.module}/templates/stage_startup.sh.tftpl", {
      host_user         = local.host_user
      manager_repo_path = local.manager_repo_path
      bee_data_root     = local.bee_data_root

      # Rendered here rather than once in a local because the labels are per host. Only plain
      # locals and the reserved monitoring address are read: taking this host's name from
      # local.hosts (render.tf) instead of local.stage_instance_names would read the instance's
      # own attribute while defining it, which is a cycle.
      alloy_provision = templatefile("${path.module}/templates/alloy_provision.sh.tftpl", {
        alloy_dir   = local.alloy_dir
        alloy_image = local.alloy_image
        host_name   = local.stage_instance_names[each.key]
        role        = "stage"
        stage       = each.key
        loki_url    = "http://${google_compute_address.monitoring_internal.address}:${local.loki_port}/loki/api/v1/push"
      })
    })
  }
}
