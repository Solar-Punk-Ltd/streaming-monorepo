# Terraform writes files and never restarts a service, exactly as ../render.tf does:
# config-then-reload ordering does not belong in a plan graph, and no provisioner appears in this
# root. Everything below lands under ../rendered/ (gitignored) and a human — or
# ../stacks/monitoring/push.sh, or streaming-infra-manager's deploy/deploy.sh — pushes it.
#
# Nothing here renders BEE_PUBLISHERS, ABR_LADDER, a port slot, a stamp or a key. Those are the
# manager's, created in its UI, and Terraform does not know they exist.

locals {
  # Every render derives from this one map, so adding a host regenerates all of them with no HCL
  # edit. Keyed by ssh alias, which is the bee_hosts key from .tfvars.
  #
  # `ip` is the RESERVED address, not the instance's main_ip attribute. They are the same value
  # once the instance is up, but the reserved one is known without reading the instance and
  # survives its replacement — so a rebuild does not churn every rendered file, and the
  # Prometheus target does not go unknown mid-plan.
  hosts = { for key, host in var.bee_hosts : key => {
    name   = local.host_names[key]
    role   = "bee"
    stage  = key
    region = host.region
    plan   = host.plan
    ip     = vultr_reserved_ip.bee[key].subnet
  } }

  host_aliases = sort(keys(local.hosts))
}

resource "local_file" "ssh_config" {
  filename             = "${local.rendered_dir}/vultr/ssh_config"
  file_permission      = "0644"
  directory_permission = "0755"

  content = templatefile("${path.module}/templates/ssh_config.tftpl", {
    user          = local.host_user
    identity_file = var.ssh_identity_file

    # Absolute paths in both: the ~/.ssh/config Include line the template prints has to name
    # this file from anywhere, and OpenSSH resolves UserKnownHostsFile against the invoking
    # process's working directory rather than the config file's location — so a relative path
    # here would scatter a known_hosts file wherever ssh happened to be run from.
    self_path   = "${local.rendered_abs}/vultr/ssh_config"
    known_hosts = "${local.rendered_abs}/vultr/known_hosts"

    hosts = [
      for alias in local.host_aliases : {
        alias = alias
        ip    = local.hosts[alias].ip
      }
    ]
  })
}

# One per host, scp'd to <manager_repo_path>/manager/.env. PUBLIC_HOST is the reserved address
# because the manager composes every rung's publisher URL as PUBLIC_HOST + (10005 + slot*10) —
# an unset or loopback value produces twelve URLs that assemble fine and mean nothing off-host,
# which is the failure streaming-infra-manager's publishUrl classifier exists to catch after the
# fact. Note that deploy/deploy.sh also exports PUBLIC_HOST from the host's default-route source
# address, which on these instances IS the reserved IP, so the two agree rather than fighting.
resource "local_sensitive_file" "manager_env" {
  for_each = var.bee_hosts

  filename             = "${local.rendered_dir}/vultr/${each.key}/manager.env"
  file_permission      = "0600"
  directory_permission = "0700"

  content = templatefile("${path.module}/templates/manager.env.tftpl", {
    postgres_password = random_password.postgres[each.key].result
    manager_port      = local.manager_api_port
    web_port          = local.manager_web_port
    public_host       = local.hosts[each.key].ip
    bee_data_root     = local.bee_data_root
  })
}

# The exact bytes the Vultr startup script carries, from the same local, so an operator can
# re-run provisioning on a live host without a rebuild:
#
#   ssh -F ../rendered/vultr/ssh_config <alias> sudo bash -s < ../rendered/vultr/<alias>/provision.sh
#
# This file is not a convenience. A Vultr startup script runs once per instance and never again
# (cloud-init vendor scripts are PER_INSTANCE), and there is no metadata script runner to invoke
# on the host, so without this copy the only way to apply a provisioning edit would be to replace
# the instance — which destroys the Bee wallets. 0755 so it is directly executable too.
resource "local_file" "provision" {
  for_each = var.bee_hosts

  filename             = "${local.rendered_dir}/vultr/${each.key}/provision.sh"
  file_permission      = "0755"
  directory_permission = "0700"
  content              = local.provision_scripts[each.key]
}

resource "local_file" "inventory" {
  filename             = "${local.rendered_dir}/vultr/inventory.json"
  file_permission      = "0644"
  directory_permission = "0755"

  content = jsonencode({
    for alias in local.host_aliases : alias => {
      name          = local.hosts[alias].name
      role          = local.hosts[alias].role
      region        = local.hosts[alias].region
      plan          = local.hosts[alias].plan
      public_ip     = local.hosts[alias].ip
      instance_id   = vultr_instance.bee[alias].id
      bee_api_ports = local.bee_api_ports
      bee_p2p_ports = local.bee_p2p_ports
    }
  })
}

# Prometheus file_sd, written into the GCP ROOT's rendered directory on purpose.
#
# ../stacks/monitoring/push.sh rsyncs ../rendered/monitoring/ to the monitoring host wholesale
# and ../stacks/monitoring/prometheus/prometheus.yml globs targets/*.json, so this file is picked
# up and shipped with no change to either — the cross-cloud scrape needs no second push path and
# no edit to the monitoring stack. The coupling is real and worth stating plainly: this root
# writes into a directory the other root owns, and the other root's push script is what delivers
# it. The two file names cannot collide (../render.tf writes nodes.json; this writes
# vultr-bee-hosts.json) and neither root's local_file ever sees the other's, so a plan in either
# is unaffected by the other's contents.
#
# PUBLIC addresses here, where the GCP root's nodes.json carries internal ones: there is no
# shared network, so the scrape crosses the internet and is admitted by this root's
# node_exporter rule, keyed on the monitoring host's own /32.
#
# Labels match the GCP root's exactly — role, stage, region, instance_name — so a Bee host lines
# up with a stage host in the same dashboard panel and the same Loki query without a translation
# table. `stage` carries the host key, which is what Alloy also stamps on this host's log lines.
resource "local_file" "prometheus_targets" {
  filename             = "${local.rendered_dir}/monitoring/prometheus/targets/vultr-bee-hosts.json"
  file_permission      = "0644"
  directory_permission = "0755"

  content = jsonencode([
    for alias in local.host_aliases : {
      targets = ["${local.hosts[alias].ip}:${local.node_exporter_port}"]
      labels = {
        role          = local.hosts[alias].role
        stage         = local.hosts[alias].stage
        region        = local.hosts[alias].region
        instance_name = local.hosts[alias].name
      }
    }
  ])
}

# The ssh config for the streaming-infra-manager host's api container — where the manager's
# deploys actually run (its Dockerfile installs openssh-client and rsync; deploy.sh calls bare
# `ssh <alias>`). Direct TCP to BOTH clouds: the Bee hosts at their reserved addresses, and the GCP
# stage hosts at the external addresses read from the GCP root's state, admitted by that root's
# ssh_external rule keyed on the manager's /32. No IAP anywhere in this file: IAP is a gcloud on a
# human's laptop, and this file is for a container on a Hetzner box.
#
# Meant to be mounted at /etc/ssh/ssh_config in that container — the system file itself, never a
# drop-in under ssh_config.d and never ~/.ssh/config: OpenSSH permission-checks Included files too
# ("Bad owner or permissions" on a mounted file owned by the host's solarpunk), and refuses
# a per-user config not owned by the user or root, and a bind-mounted file keeps the host's
# solarpunk uid, while the system-wide file has no ownership check. The identity and known_hosts
# paths are the container's (see locals.tf). The operator scps this file to the manager host.
resource "local_file" "manager_ssh_config" {
  filename             = "${local.rendered_dir}/vultr/manager_ssh_config"
  file_permission      = "0644"
  directory_permission = "0755"

  content = templatefile("${path.module}/templates/manager_ssh_config.tftpl", {
    user          = local.host_user
    identity_file = local.manager_ssh_identity_file
    known_hosts   = local.manager_ssh_known_hosts
    hosts = concat(
      [for alias in local.host_aliases : { alias = alias, ip = local.hosts[alias].ip }],
      [for key in sort(keys(local.gcp_stage_ips)) : { alias = key, ip = local.gcp_stage_ips[key] }],
    )
  })
}
