locals {
  # Zone derivation lives here so the stage object in .tfvars stays region/srt_port/machine.
  stage_zones     = { for key, stage in var.stages : key => "${stage.region}-a" }
  monitoring_zone = "${var.monitoring_region}-a"

  # One subnet per region actually in use, the monitoring region included.
  subnet_regions = toset(concat([for stage in var.stages : stage.region], [var.monitoring_region]))

  # lookup with a null default rather than a bare index: the subnet_cidrs validation has already
  # rejected a missing region by the time this is read, and a null reads better than a map index
  # error if it ever is not.
  subnet_cidr_by_region = { for region in local.subnet_regions : region => lookup(var.subnet_cidrs, region, null) }

  stage_tag      = "${var.name_prefix}-stage"
  monitoring_tag = "${var.name_prefix}-monitoring"

  stage_instance_names     = { for key, stage in var.stages : key => "${var.name_prefix}-stage-${key}" }
  monitoring_instance_name = "${var.name_prefix}-monitoring"

  node_exporter_port = 9100
  manager_api_port   = 9876
  manager_web_port   = 8080
  loki_port          = 3100

  # Alloy is machine provisioning like node_exporter, so both startup templates write its
  # payload. The pin lives here so one digest covers both of them and they cannot drift apart.
  # Same rule as the monitoring compose file: the tag is there to be read, the digest is the pin.
  alloy_dir   = "/opt/devcon-alloy"
  alloy_image = "grafana/alloy:v1.19.2@sha256:b8ec653c44235fbe910879145dac3597d66b0aaecf60bcbbe82580767771a839"

  iap_source_range = "35.235.240.0/20" # Google's IAP TCP forwarding range, fixed

  # Hardcoded upstream in streaming-infra-manager: its compose file bind-mounts these literal
  # paths on both sides, so they are a contract rather than a preference.
  host_user         = "solarpunk"
  manager_repo_path = "/home/solarpunk/streaming-infra-manager"
  bee_data_root     = "/home/solarpunk/streaming-infra-manager-data"

  # Monitoring host: push.sh target and the mount point of the TSDB disk.
  monitoring_stack_dir = "/home/solarpunk/monitoring"
  monitoring_data_dir  = "/var/lib/monitoring"

  rendered_dir = "${path.module}/rendered"
}
