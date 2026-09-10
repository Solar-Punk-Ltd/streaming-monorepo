# One firewall group, attached to every Bee host. A Vultr firewall group is default-deny inbound
# from the moment it is attached and does not filter outbound at all, so the rules below are the
# complete list of what can reach these hosts — the same shape as the GCP root's VPC rules, and
# the same warning applies: nothing on a Bee host authenticates, so matching a rule here IS the
# authorization event.
#
# There is no VPC and no private network in this root. The hosts are reached over public
# addresses with source allowlists, which is a deliberate first step and not the end state: a
# WireGuard mesh between the GCP stage hosts and the Bee hosts would move the Bee API and the
# monitoring traffic off the public internet entirely, and is the intended follow-up. Until then
# three things cross the internet in cleartext — the Bee API calls from a stage's uploader, the
# Prometheus scrape and the Alloy log push — each gated by a /32.
#
# RULE BUDGET. A Vultr firewall group has a hard cap (the API reports it as max_rule_count,
# commonly 50). This design spends:
#
#   len(ssh_source_ranges ∪ ssh_operator_source_ranges)   ssh
# + len(stage_external_ips) + len(bee_api_source_ranges)   Bee API band, one per stage host and per manager address
# + ladders_per_host * rungs_per_ladder                   Bee P2P, one per slot
# + 1                                                     node_exporter scrape
# + 1                                                     ICMP
#
# which for the POC (one host, three ladders, one stage, one operator address) is 16. The slot
# total is capped at 20 by var.ladders_per_host's validation so the P2P rules alone cannot eat
# the budget, and the check block at the bottom of this file compares the count against the
# group's own reported cap after apply.
resource "vultr_firewall_group" "bee" {
  description = "${var.name_prefix}-bee"

  lifecycle {
    # Refused here rather than at the rule that would fail, because this group is the first thing
    # every other resource in this root depends on: a missing GCP state stops the apply before an
    # instance with a public address and an unauthenticated Bee API exists at all. data.tf's check
    # block says the same thing as a plan-time warning; this is the part that blocks.
    precondition {
      condition     = length(local.gcp_stage_ips) > 0
      error_message = "No stage addresses in the GCP root's state (output stage_external_ips): apply ../ with at least one stage in ../envs/poc.tfvars before this root. Without them the Bee API band rule has no sources, and no stage uploader could reach these publishers."
    }

    precondition {
      condition     = local.gcp_monitoring_ip != ""
      error_message = "No monitoring address in the GCP root's state (output monitoring_external_ip): apply ../ before this root. Without it there is no scrape rule and no Loki endpoint for these hosts' Alloy to push to."
    }
  }
}

# sshd, one rule per allowed source. Absent rather than wide open when both lists are empty,
# which is the resting state between test windows: no rule, no reachable sshd. Deploying the
# manager needs this open; the Bee nodes publishing does not.
resource "vultr_firewall_rule" "ssh" {
  for_each = local.ssh_rules

  firewall_group_id = vultr_firewall_group.bee.id
  protocol          = "tcp"
  ip_type           = "v4"
  subnet            = each.value.subnet
  subnet_size       = each.value.subnet_size
  port              = tostring(local.ssh_port)
  notes             = "ssh from an allowed source"
}

# The Bee API band, admitted ONLY from the GCP stage hosts' external addresses and the manager
# host(s) in var.bee_api_source_ranges.
#
# This is the load-bearing rule of the whole root. A Bee node's API has no authentication of any
# kind, and swarm-hls-stream binds it on 0.0.0.0 (BEE_UPLOADER_API_BIND defaults to 0.0.0.0 in
# nodes/docker-compose.yml) so that an off-host stream-uploader can reach it — anyone who reaches
# one of these ports can spend the node's postage batches and read its wallet state. The stage
# addresses, plus the manager host that buys the batches, are the entire control.
#
# GCP VM egress leaves through the instance's own external address, which is what makes a /32
# allowlist meaningful on this side: those addresses are reserved in the GCP root precisely so
# they survive a stage rebuild (see ../stages.tf).
#
# One band per stage rather than one rule per port per stage — see local.bee_api_port_band on
# what else the band admits and why that is bounded by this source list rather than by the port
# numbers.
resource "vultr_firewall_rule" "bee_api" {
  for_each = local.bee_api_rules

  firewall_group_id = vultr_firewall_group.bee.id
  protocol          = "tcp"
  ip_type           = "v4"
  subnet            = each.value.subnet
  subnet_size       = each.value.subnet_size
  port              = local.bee_api_port_band
  notes             = "bee api band from ${each.key}"
}

# Bee P2P, public by design: a publisher that cannot be dialled by arbitrary peers cannot push
# chunks into Swarm, so there is no allowlist to write here. tcp only — bee's libp2p host
# registers the TCP transport and, optionally, websockets on top of it (pkg/p2p/libp2p), and no
# UDP or QUIC transport at all, so a UDP rule would open a port nothing listens on.
#
# One rule per slot rather than a band, because a band from 0.0.0.0/0 would also publish the API
# ports interleaved with them, and that is the one thing this firewall exists to prevent. Twelve
# rules is what that costs; the budget comment above accounts for it.
resource "vultr_firewall_rule" "bee_p2p" {
  for_each = { for port in local.bee_p2p_ports : tostring(port) => port }

  firewall_group_id = vultr_firewall_group.bee.id
  protocol          = "tcp"
  ip_type           = "v4"
  subnet            = "0.0.0.0"
  subnet_size       = 0
  port              = each.key
  notes             = "bee p2p slot port ${each.key}"
}

# node_exporter, scraped by Prometheus on the GCP monitoring host over the public internet.
# Source is that host's reserved external /32: unlike the GCP root's scrape rule, which filters
# by service account, there is no shared identity plane between the clouds, so the address is the
# identity. The exporter serves unauthenticated metrics, which name every process and mount on
# the host — this is the only thing keeping that read private.
resource "vultr_firewall_rule" "node_exporter" {
  firewall_group_id = vultr_firewall_group.bee.id
  protocol          = "tcp"
  ip_type           = "v4"
  subnet            = local.gcp_monitoring_ip
  subnet_size       = 32
  port              = tostring(local.node_exporter_port)
  notes             = "node_exporter scrape from gcp monitoring"
}

# ICMP from anywhere, kept rather than dropped. Not for ping: what matters is that these hosts
# push media chunks and log batches to endpoints across the public internet, and path MTU
# discovery works by a router on the path returning ICMP "fragmentation needed" INBOUND. Drop
# that and large writes stall instead of failing — a black hole that looks like a slow Bee node
# and takes a day to find. Vultr's rules are per protocol with no type granularity, so admitting
# ICMP wholesale is the only way to admit that one message; what it also admits is echo and
# traceroute, which is a debuggability gain rather than a cost.
resource "vultr_firewall_rule" "icmp" {
  firewall_group_id = vultr_firewall_group.bee.id
  protocol          = "icmp"
  ip_type           = "v4"
  subnet            = "0.0.0.0"
  subnet_size       = 0
  notes             = "icmp: path mtu discovery, ping, traceroute"
}

# The budget arithmetic in the header comment is NOT asserted against the group's own reported
# cap, although it looks like it should be. vultr/vultr 2.32.0's website documentation lists
# `max_rule_count`, `rule_count` and `instance_count` as exported attributes of
# vultr_firewall_group, but the resource schema in that release exports only description,
# date_created and date_modified — reading max_rule_count fails at validate. So the count is
# published as an output (see outputs.tf) for a human to compare against
# `vultr-cli firewall group list`, and the hard guard is var.ladders_per_host's 20-slot
# validation, which is what keeps the P2P rules alone from eating a 50-rule budget.
