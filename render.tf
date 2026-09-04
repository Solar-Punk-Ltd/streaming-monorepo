# Terraform writes files and never restarts a service: config-then-reload ordering does not
# belong in a plan graph. Everything below lands under terraform/rendered/ and a human (or
# stacks/monitoring/push.sh, or deploy/deploy.sh) pushes it.
#
# Nothing here renders BEE_PUBLISHERS, ABR_LADDER, stamps or keys. Those live in the
# hand-authored swarm-hls-stream env, which Terraform does not touch.

locals {
  # Every render derives from this one map, so adding a stage regenerates all of them with no
  # HCL edit. Keyed by ssh alias: the stage key from .tfvars, or "monitoring".
  hosts = merge(
    {
      for key, stage in var.stages : key => {
        name        = google_compute_instance.stage[key].name
        role        = "stage"
        stage       = key
        region      = stage.region
        zone        = local.stage_zones[key]
        machine     = stage.machine
        internal_ip = google_compute_address.stage_internal[key].address
        external_ip = google_compute_address.stage[key].address
        srt_port    = stage.srt_port
      }
    },
    {
      monitoring = {
        name        = google_compute_instance.monitoring.name
        role        = "monitoring"
        stage       = "monitoring"
        region      = var.monitoring_region
        zone        = local.monitoring_zone
        machine     = var.monitoring_machine
        internal_ip = google_compute_address.monitoring_internal.address
        external_ip = google_compute_address.monitoring.address
        srt_port    = null
      }
    }
  )

  host_aliases = sort(keys(local.hosts))
}

resource "local_sensitive_file" "manager_env" {
  for_each = var.stages

  filename             = "${local.rendered_dir}/${each.key}/manager.env"
  file_permission      = "0600"
  directory_permission = "0700"

  content = templatefile("${path.module}/templates/manager.env.tftpl", {
    postgres_password = random_password.postgres[each.key].result
    manager_port      = local.manager_api_port
    web_port          = local.manager_web_port
    public_host       = google_compute_address.stage[each.key].address
    bee_data_root     = local.bee_data_root
  })
}

resource "local_file" "ssh_config" {
  filename             = "${local.rendered_dir}/ssh_config"
  file_permission      = "0644"
  directory_permission = "0755"

  content = templatefile("${path.module}/templates/ssh_config.tftpl", {
    project       = var.project_id
    user          = local.host_user
    identity_file = var.ssh_identity_file
    hosts = [
      for alias in local.host_aliases : {
        alias         = alias
        instance_name = local.hosts[alias].name
        zone          = local.hosts[alias].zone
      }
    ]
  })
}

# Prometheus file_sd. Internal IPs: the scrape firewall rule filters by source service
# account, which never matches traffic aimed at an instance's external address.
resource "local_file" "prometheus_targets" {
  filename             = "${local.rendered_dir}/monitoring/prometheus/targets/nodes.json"
  file_permission      = "0644"
  directory_permission = "0755"

  content = jsonencode([
    for alias in local.host_aliases : {
      targets = ["${local.hosts[alias].internal_ip}:${local.node_exporter_port}"]
      labels = {
        role          = local.hosts[alias].role
        stage         = local.hosts[alias].stage
        region        = local.hosts[alias].region
        instance_name = local.hosts[alias].name
      }
    }
  ])
}

resource "local_file" "grafana_datasources" {
  filename             = "${local.rendered_dir}/monitoring/grafana/provisioning/datasources/datasources.yml"
  file_permission      = "0644"
  directory_permission = "0755"

  content = templatefile("${path.module}/templates/datasources.yml.tftpl", {
    prometheus_url = "http://prometheus:9090"
    loki_url       = "http://loki:3100"
  })
}

resource "local_sensitive_file" "monitoring_env" {
  filename             = "${local.rendered_dir}/monitoring/.env"
  file_permission      = "0600"
  directory_permission = "0700"

  content = templatefile("${path.module}/templates/monitoring.env.tftpl", {
    grafana_admin_password = random_password.grafana_admin.result
  })
}

resource "local_file" "inventory" {
  filename             = "${local.rendered_dir}/inventory.json"
  file_permission      = "0644"
  directory_permission = "0755"

  content = jsonencode({
    for alias in local.host_aliases : alias => merge(
      {
        name        = local.hosts[alias].name
        role        = local.hosts[alias].role
        stage       = local.hosts[alias].stage
        region      = local.hosts[alias].region
        zone        = local.hosts[alias].zone
        machine     = local.hosts[alias].machine
        internal_ip = local.hosts[alias].internal_ip
        external_ip = local.hosts[alias].external_ip
      },
      local.hosts[alias].srt_port == null ? {} : { srt_port = local.hosts[alias].srt_port }
    )
  })
}
