locals {
  host_names = { for key, host in var.bee_hosts : key => "${var.name_prefix}-bee-${key}" }

  # Capacity only. See the comment on var.ladders_per_host: this number sizes a port band and
  # nothing else. No resource is created per rung.
  bee_slots_per_host = var.ladders_per_host * var.rungs_per_ladder
  bee_slots          = range(1, local.bee_slots_per_host + 1)

  # Port arithmetic, verified against swarm-hls-stream's deploy/scripts/_lib.sh PORT_VARS and
  # streaming-infra-manager's DeploymentOrchestrator PORT_VAR_DEFAULTS, which are kept in step
  # with each other: every port is `base + slot * 10`, and slot 0 means "the bare defaults".
  # A bee-uploader profile takes two of them.
  bee_api_base = 10005 # slot 1 → 10015
  bee_p2p_base = 10006 # slot 1 → 10016
  slot_stride  = 10

  bee_api_ports = [for slot in local.bee_slots : local.bee_api_base + local.slot_stride * slot]
  bee_p2p_ports = [for slot in local.bee_slots : local.bee_p2p_base + local.slot_stride * slot]

  # One contiguous band rather than one rule per API port, because the band is what fits in the
  # rule budget: 12 slots would otherwise cost 12 rules per stage host instead of one, and 12
  # stages' worth of that would not fit in a Vultr firewall group at all.
  #
  # Be clear about what the band widens. From slot 1's API port to slot 12's it admits EVERY port
  # in between, not just the twelve API ports: the P2P ports (public anyway, see firewall.tf), the
  # bee-gateway pair at 10007 + 10s and 10008 + 10s, and — for slots 2 and above — the media
  # profile's own range at 10000..10004 + 10s. None of those run on a Bee host, which carries
  # bee-uploader profiles and nothing else, and the band is only ever opened to the GCP stage
  # addresses. So the widening is bounded by that source list rather than by the port numbers,
  # which is the trade being made: one rule per stage, and a stage host that could reach a port on
  # a Bee host that nothing is listening on.
  bee_api_port_band = "${local.bee_api_base + local.slot_stride}:${local.bee_api_base + local.slot_stride * local.bee_slots_per_host}"

  node_exporter_port = 9100
  loki_port          = 3100
  manager_api_port   = 9876
  manager_web_port   = 8080
  ssh_port           = 22

  # Alloy is machine provisioning like node_exporter, and the digest is pinned here to the same
  # value as ../locals.tf on purpose: the two roots render ONE shared fragment
  # (../templates/alloy_provision.sh.tftpl) and ship logs into one Loki, so a version skew
  # between the roots would show up as a label or protocol difference between hosts in the same
  # Grafana query. The two roots must move together — change both digests in the same commit.
  alloy_dir   = "/opt/devcon-alloy"
  alloy_image = "grafana/alloy:v1.19.2@sha256:b8ec653c44235fbe910879145dac3597d66b0aaecf60bcbbe82580767771a839"

  # Hardcoded upstream in streaming-infra-manager: its compose file bind-mounts these literal
  # paths on both sides and its deploy.sh rsyncs to that literal path, so they are a contract
  # rather than a preference. Identical literals to ../locals.tf, for the same reason.
  host_user         = "solarpunk"
  manager_repo_path = "/home/solarpunk/streaming-infra-manager"
  bee_data_root     = "/home/solarpunk/streaming-infra-manager-data"

  # The GCP root's rendered directory, on purpose and not by accident. Everything this root
  # writes lands under rendered/vultr/, except the Prometheus file_sd target list, which lands
  # next to the GCP root's nodes.json so ../stacks/monitoring/push.sh ships it with no change at
  # all (prometheus.yml globs targets/*.json). See render.tf.
  rendered_dir = "${path.module}/../rendered"

  # Absolute, because two consumers cannot use a relative path: UserKnownHostsFile inside the
  # rendered ssh_config (ssh resolves it against the invoking process's cwd, not the config's
  # location) and the `Include` line a human puts in ~/.ssh/config so the manager's deploy.sh —
  # which calls bare `ssh <alias>` and never `ssh -F` — can resolve these aliases.
  rendered_abs = abspath(local.rendered_dir)

  # The committed roster plus whatever scripts/allow-me.sh wrote for this window.
  ssh_ranges = distinct(concat(var.ssh_source_ranges, var.ssh_operator_source_ranges))

  # Vultr firewall rules take an address and a prefix length as two separate arguments rather
  # than one CIDR string. cidrhost(cidr, 0) normalises the address first, so "1.2.3.4/24" in
  # tfvars becomes 1.2.3.0/24 in the rule instead of being rejected or silently truncated by
  # the API.
  ssh_rules = { for cidr in local.ssh_ranges : cidr => {
    subnet      = cidrhost(cidr, 0)
    subnet_size = tonumber(split("/", cidr)[1])
  } }

  gcp_stage_rules = { for key, ip in local.gcp_stage_ips : key => {
    subnet      = ip
    subnet_size = 32
  } }

  # Everything allowed to reach the Bee API band: the stage hosts (from the GCP root's state) plus
  # the committed manager address(es). Keyed by stage name or CIDR, which is what the rule notes
  # show in the Vultr console.
  bee_api_rules = merge(local.gcp_stage_rules, { for cidr in var.bee_api_source_ranges : cidr => {
    subnet      = cidrhost(cidr, 0)
    subnet_size = tonumber(split("/", cidr)[1])
  } })

  # Paths INSIDE the manager's api container, where its deploys run (streaming-infra-manager's
  # Dockerfile: node:22-alpine with openssh-client and rsync, running as root). The rendered
  # manager_ssh_config is written for that process, not for a laptop — see render.tf.
  manager_ssh_identity_file = "/root/.ssh/manager_deploy"
  manager_ssh_known_hosts   = "/root/.ssh/known_hosts"

  # The rule budget, counted rather than asserted in prose, and published as the
  # firewall_rule_budget output: the provider does not expose the group's max_rule_count (see the
  # closing comment in firewall.tf), so a human compares this against `vultr-cli firewall group list`.
  firewall_rule_count = length(local.ssh_rules) + length(local.bee_api_rules) + local.bee_slots_per_host + 2
}
