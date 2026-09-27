output "bee_host_ips" {
  description = "Reserved public address per Bee host. STEP 2 OF THE ROLLOUT: put these as /32s into loki_push_source_ranges in ../envs/poc.tfvars and apply the GCP root, or these hosts' Alloy cannot reach Loki. They are also the address a stage's uploader dials for the Bee API, PUBLIC_HOST in manager/.env, and what BEE_UPLOADER_NAT_ADDR must be set to in the manager UI."
  value       = { for key, ip in vultr_reserved_ip.bee : key => ip.subnet }
}

output "bee_api_port_band" {
  description = "The tcp port range the firewall admits from the GCP stage addresses, covering every slot's Bee API port. Slot s serves its API on 10005 + 10s, so slot 1 is 10015. Unauthenticated: this band is open to the stage hosts and to nobody else."
  value       = local.bee_api_port_band
}

output "bee_p2p_ports" {
  description = "Bee P2P ports, one per slot (10006 + 10s), each open to 0.0.0.0/0 because a publisher has to be dialable. Set the manager's port slots to 1..N over these, so every node lands on a port that is actually admitted."
  value       = local.bee_p2p_ports
}

output "firewall_group_id" {
  description = "The Vultr firewall group every Bee host is attached to. Useful for `vultr-cli firewall rule list <id>` when checking what is actually open against what this root thinks is."
  value       = vultr_firewall_group.bee.id
}

output "rendered_files" {
  description = "What Terraform wrote for the applier to push. Terraform does not push them and does not restart anything. prometheus_targets deliberately lands in the GCP root's rendered tree, so ../stacks/monitoring/push.sh ships it unchanged."
  value = {
    ssh_config         = local_file.ssh_config.filename
    manager_ssh_config = local_file.manager_ssh_config.filename
    inventory          = local_file.inventory.filename
    prometheus_targets = local_file.prometheus_targets.filename
    manager_env        = { for key, file in local_sensitive_file.manager_env : key => file.filename }
    provision          = { for key, file in local_file.provision : key => file.filename }
  }
}

output "ssh_hint" {
  description = "How a human reaches these hosts. The manager does not use this file: it deploys from its own host with the rendered manager_ssh_config (see rendered_files)."
  value = {
    direct                 = "ssh -F ${local.rendered_abs}/vultr/ssh_config ${try(local.host_aliases[0], "<alias>")}"
    ssh_config_include     = "Include ${local.rendered_abs}/vultr/ssh_config"
    known_hosts_on_rebuild = "rm -f ${local.rendered_abs}/vultr/known_hosts"
  }
}

# The rule budget, published rather than asserted: see the closing comment in firewall.tf on why
# the group's own max_rule_count cannot be read in this provider release. Compare `used` against
# what `vultr-cli firewall group list` reports for the group before adding a host, a ladder or an
# ssh range — every one of those costs at least one rule.
output "firewall_rule_budget" {
  description = "Rules this design puts in the Vultr firewall group, broken down. A group's cap is commonly 50; Vultr reports the real number per group and the provider does not expose it."
  value = {
    used          = local.firewall_rule_count
    ssh           = length(local.ssh_rules)
    bee_api_band  = length(local.bee_api_rules)
    bee_p2p       = local.bee_slots_per_host
    node_exporter = 1
    icmp          = 1
  }
}
