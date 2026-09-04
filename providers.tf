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
