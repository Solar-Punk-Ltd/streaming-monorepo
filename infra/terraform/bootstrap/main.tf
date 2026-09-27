terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.44"
    }
  }
}

provider "google" {
  project = var.project_id

  # Metering the cost from day one is a plan requirement, and Terraform is one tenant in a
  # shared project: without a uniform label the idle remainder — reserved addresses, disks —
  # cannot be isolated in the billing export. The goog- prefix is Google's, and the provider
  # injects its own attribution label alongside these.
  default_labels = {
    environment = "poc"
    workload    = "devcon-streaming"
  }
}

# Local state, and the only root here that has it: this bucket is where the parent root keeps
# its state, so it cannot keep its own inside itself.
resource "google_storage_bucket" "state" {
  name     = var.state_bucket_name
  project  = var.project_id
  location = "EU"

  # Version history is the point of the bucket: a bad apply stays recoverable.
  versioning {
    enabled = true
  }

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # A bucket holding Terraform state must refuse to be emptied by a destroy.
  force_destroy = false

  # Old versions are the recovery mechanism, not an archive: keep a bounded window instead of
  # accumulating every apply forever.
  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      with_state         = "ARCHIVED"
      num_newer_versions = 30
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}
