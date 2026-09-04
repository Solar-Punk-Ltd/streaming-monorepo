output "stage_external_ips" {
  description = "Static external address per stage. These double as the egress identity a Hetzner-side allowlist keys on: GCP VM egress leaves through the instance's own external address."
  value       = { for key, address in google_compute_address.stage : key => address.address }
}

output "monitoring_external_ip" {
  description = "Static external address of the monitoring host. Nothing on it is published off-host; reach Grafana with `ssh -L 3000:localhost:3000 monitoring`."
  value       = google_compute_address.monitoring.address
}

output "instance_names" {
  description = "Instance name per ssh alias. An IAP tunnel targets a name, not an address."
  value       = { for alias in local.host_aliases : alias => local.hosts[alias].name }
}

output "rendered_files" {
  description = "What Terraform wrote for the applier to push. Terraform does not push them and does not restart anything."
  value = {
    ssh_config          = local_file.ssh_config.filename
    inventory           = local_file.inventory.filename
    prometheus_targets  = local_file.prometheus_targets.filename
    grafana_datasources = local_file.grafana_datasources.filename
    monitoring_env      = local_sensitive_file.monitoring_env.filename
    manager_env         = { for key, file in local_sensitive_file.manager_env : key => file.filename }
  }
}

output "srt_ingest_endpoints" {
  description = "host:port an encoder pushes SRT to, per stage: the external address, since the internal one is reachable only from inside the VPC. OBS form: srt://<endpoint>?streamid=#!::r=live/stream,m=publish"
  value       = { for key, stage in var.stages : key => "${google_compute_address.stage[key].address}:${stage.srt_port}" }
}
