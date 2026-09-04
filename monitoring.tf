resource "google_compute_address" "monitoring" {
  name         = "${local.monitoring_instance_name}-ip"
  project      = var.project_id
  region       = var.monitoring_region
  address_type = "EXTERNAL"

  # Nothing else in this resource reaches the Compute API, so the enablement is not implied.
  depends_on = [google_project_service.required]
}

# The TSDB lives on its own disk so the host can be rebuilt without losing the history that
# makes the two-region comparison readable.
resource "google_compute_disk" "tsdb" {
  name    = "${local.monitoring_instance_name}-tsdb"
  project = var.project_id
  zone    = local.monitoring_zone
  type    = "pd-balanced"
  size    = var.tsdb_disk_gb

  # Nothing else in this resource reaches the Compute API, so the enablement is not implied.
  depends_on = [google_project_service.required]
}

# Reserved for the same reason as the stage hosts' internal addresses: the scrape target must
# survive a rebuild of the host it names.
resource "google_compute_address" "monitoring_internal" {
  name         = "${local.monitoring_instance_name}-internal"
  project      = var.project_id
  region       = var.monitoring_region
  subnetwork   = google_compute_subnetwork.subnet[var.monitoring_region].id
  address_type = "INTERNAL"
  purpose      = "GCE_ENDPOINT"
}

resource "google_compute_instance" "monitoring" {
  name         = local.monitoring_instance_name
  project      = var.project_id
  zone         = local.monitoring_zone
  machine_type = var.monitoring_machine
  tags         = [local.monitoring_tag]

  allow_stopping_for_update = true

  lifecycle {
    # Same as the stage hosts: the image data source floats, and a changed boot image forces
    # replacement. The TSDB disk would survive it, but the rebuild is still not a diff to show
    # on an apply that changed nothing.
    ignore_changes = [boot_disk[0].initialize_params[0].image]
  }

  labels = {
    role = "monitoring"
  }

  boot_disk {
    initialize_params {
      image = data.google_compute_image.ubuntu.self_link
      size  = var.monitoring_boot_disk_gb
      type  = "pd-balanced"
    }
  }

  attached_disk {
    source = google_compute_disk.tsdb.id

    # Fixes the guest path to /dev/disk/by-id/google-tsdb, which is what the startup script
    # formats and mounts. Device order is not stable; this name is.
    device_name = "tsdb"
  }

  network_interface {
    subnetwork = google_compute_subnetwork.subnet[var.monitoring_region].id
    network_ip = google_compute_address.monitoring_internal.address

    access_config {
      nat_ip = google_compute_address.monitoring.address
    }
  }

  service_account {
    email  = google_service_account.monitoring.email
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

    # Same reasoning as the stage hosts: project-level keys must not become sudo here.
    block-project-ssh-keys = "TRUE"

    startup-script = templatefile("${path.module}/templates/monitoring_startup.sh.tftpl", {
      host_user      = local.host_user
      stack_dir      = local.monitoring_stack_dir
      data_dir       = local.monitoring_data_dir
      disk_device_id = "tsdb"

      # Same nesting as the stage hosts, and the same reason for local.monitoring_instance_name
      # rather than this instance's own name attribute. The push URL is this host's own reserved
      # internal address: host-local delivery, so it is never evaluated against a firewall rule,
      # and it keeps one code path for both roles instead of a loopback special case.
      alloy_provision = templatefile("${path.module}/templates/alloy_provision.sh.tftpl", {
        alloy_dir   = local.alloy_dir
        alloy_image = local.alloy_image
        host_name   = local.monitoring_instance_name
        role        = "monitoring"
        stage       = "monitoring"
        loki_url    = "http://${google_compute_address.monitoring_internal.address}:${local.loki_port}/loki/api/v1/push"
      })
    })
  }
}
